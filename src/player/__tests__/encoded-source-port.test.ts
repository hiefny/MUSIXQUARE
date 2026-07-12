import { describe, expect, it, vi } from 'vitest';
import {
  EncodedSourceClosedError,
  EncodedSourceRangeError,
  type EncodedAudioSource,
} from '../sources/encoded-audio-source.ts';
import {
  ENCODED_SOURCE_PORT_MAX_READ_BYTES,
  EncodedSourcePortBroker,
  EncodedSourcePortClient,
  EncodedSourcePortError,
} from '../sources/encoded-source-port.ts';

type MessageListener = (event: MessageEvent<unknown>) => void;

class FakeMessagePort {
  readonly listeners = new Set<MessageListener>();
  readonly lifecycleListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  readonly sent: unknown[] = [];
  peer: FakeMessagePort | null = null;
  closed = false;
  failPost = false;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message') {
      this.listeners.add(listener as MessageListener);
      return;
    }
    const listeners = this.lifecycleListeners.get(type) ?? new Set();
    listeners.add(listener);
    this.lifecycleListeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'message') {
      this.listeners.delete(listener as MessageListener);
      return;
    }
    this.lifecycleListeners.get(type)?.delete(listener);
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }

  postMessage(value: unknown): void {
    if (this.failPost || this.closed) throw new DOMException('port unavailable', 'DataCloneError');
    this.sent.push(value);
    this.peer?.emit(value);
  }

  emit(value: unknown): void {
    for (const listener of [...this.listeners]) {
      listener({ data: value } as MessageEvent<unknown>);
    }
  }

  emitLifecycle(type: 'close' | 'messageerror'): void {
    const event = new Event(type);
    for (const listener of [...(this.lifecycleListeners.get(type) ?? [])]) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

function portPair(): readonly [FakeMessagePort, FakeMessagePort] {
  const left = new FakeMessagePort();
  const right = new FakeMessagePort();
  left.peer = right;
  right.peer = left;
  return [left, right] as const;
}

function asPort(port: FakeMessagePort): MessagePort {
  return port as unknown as MessagePort;
}

function encodedSource(
  readAt: EncodedAudioSource['readAt'],
  options: { readonly size?: number; readonly close?: () => Promise<void> } = {},
): EncodedAudioSource {
  return {
    kind: 'blob',
    size: options.size ?? 1024,
    identity: 'source:fixture',
    metadata: { name: 'fixture.flac', mime: 'audio/flac' },
    readAt,
    close: options.close ?? vi.fn(async () => undefined),
  };
}

function command(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, entries);
}

async function flushTasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('EncodedSourcePort bridge', () => {
  it('works across a real structured-clone MessageChannel', async () => {
    const channel = new MessageChannel();
    const source = encodedSource(async (offset, length) =>
      Uint8Array.from({ length }, (_, index) => offset + index),
    );
    const broker = new EncodedSourcePortBroker({
      source,
      port: channel.port1,
      generation: 101,
    });
    const client = new EncodedSourcePortClient({
      port: channel.port2,
      generation: 101,
      size: source.size,
    });

    await expect(client.readAt(11, 4, new AbortController().signal)).resolves.toEqual(
      Uint8Array.of(11, 12, 13, 14),
    );
    await client.close();
    await vi.waitFor(() => expect(broker.closed).toBe(true));
  });

  it('copies an exact bounded read through a dedicated broker generation', async () => {
    const [brokerPort, clientPort] = portPair();
    const backing = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const source = encodedSource(
      async (offset, length) => backing.subarray(offset, offset + length),
      {
        size: backing.byteLength,
      },
    );
    const broker = new EncodedSourcePortBroker({
      source,
      port: asPort(brokerPort),
      generation: 7,
    });
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 7,
      size: backing.byteLength,
    });

    const result = await client.readAt(4, 8, new AbortController().signal);
    expect([...result]).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    backing[4] = 255;
    expect(result[0]).toBe(5);
    await flushTasks();
    expect(broker.physicalReadCount).toBe(0);
    expect(client.pendingReadCount).toBe(0);

    await client.close();
    expect(broker.closed).toBe(true);
  });

  it('handles zero-byte reads locally and rejects invalid or oversized ranges', async () => {
    const [brokerPort, clientPort] = portPair();
    const readAt = vi.fn(async () => new Uint8Array(0));
    const broker = new EncodedSourcePortBroker({
      source: encodedSource(readAt, { size: ENCODED_SOURCE_PORT_MAX_READ_BYTES + 1 }),
      port: asPort(brokerPort),
      generation: 1,
    });
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 1,
      size: ENCODED_SOURCE_PORT_MAX_READ_BYTES + 1,
    });

    await expect(client.readAt(0, 0, new AbortController().signal)).resolves.toHaveLength(0);
    await expect(
      client.readAt(0, ENCODED_SOURCE_PORT_MAX_READ_BYTES + 1, new AbortController().signal),
    ).rejects.toBeInstanceOf(EncodedSourceRangeError);
    await expect(
      client.readAt(2, ENCODED_SOURCE_PORT_MAX_READ_BYTES, new AbortController().signal),
    ).rejects.toBeInstanceOf(EncodedSourceRangeError);
    expect(readAt).not.toHaveBeenCalled();

    await client.close();
    broker.close();
  });

  it('limits worker-side pending reads without queueing unbounded work', async () => {
    const [brokerPort, clientPort] = portPair();
    const source = encodedSource(() => new Promise<Uint8Array>(() => undefined));
    const broker = new EncodedSourcePortBroker({
      source,
      port: asPort(brokerPort),
      generation: 2,
    });
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 2,
      size: source.size,
    });
    const firstController = new AbortController();
    const first = client.readAt(0, 1, firstController.signal);

    await expect(client.readAt(1, 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'busy',
    });
    expect(client.pendingReadCount).toBe(1);
    firstController.abort(new DOMException('test abort', 'AbortError'));
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.pendingReadCount).toBe(0);
    expect(broker.physicalReadCount).toBe(1);

    await client.close();
  });

  it('rejects an aborted read immediately but retains its physical task until settlement', async () => {
    const [brokerPort, clientPort] = portPair();
    let resolvePhysical!: (bytes: Uint8Array) => void;
    const source = encodedSource(
      () =>
        new Promise<Uint8Array>((resolve) => {
          resolvePhysical = resolve;
        }),
    );
    const broker = new EncodedSourcePortBroker({
      source,
      port: asPort(brokerPort),
      generation: 3,
    });
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 3,
      size: source.size,
    });
    const controller = new AbortController();
    const read = client.readAt(0, 4, controller.signal);
    await flushTasks();

    controller.abort(new DOMException('caller stopped', 'AbortError'));
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    expect(broker.physicalReadCount).toBe(1);
    expect(clientPort.sent.at(-1)).toEqual({
      type: 'encoded-source:cancel',
      generation: 3,
      decoderGeneration: 1,
      requestId: 1,
      offset: 0,
      length: 4,
    });

    resolvePhysical(Uint8Array.of(1, 2, 3, 4));
    await flushTasks();
    expect(broker.physicalReadCount).toBe(0);
    expect(client.closed).toBe(false);
    await client.close();
  });

  it('bounds cancellation churn when physical reads never settle', async () => {
    const [brokerPort, clientPort] = portPair();
    const source = encodedSource(() => new Promise<Uint8Array>(() => undefined));
    const broker = new EncodedSourcePortBroker({
      source,
      port: asPort(brokerPort),
      generation: 4,
      maxPhysicalReads: 3,
    });
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 4,
      size: source.size,
    });

    for (let index = 0; index < 3; index += 1) {
      const controller = new AbortController();
      const read = client.readAt(index, 1, controller.signal);
      controller.abort(new DOMException('cancel churn', 'AbortError'));
      await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    }
    expect(broker.physicalReadCount).toBe(3);

    for (let index = 0; index < 40; index += 1) {
      await expect(client.readAt(index, 1, new AbortController().signal)).rejects.toMatchObject({
        code: 'busy',
      });
      expect(broker.physicalReadCount).toBe(3);
      expect(client.pendingReadCount).toBe(0);
    }

    await client.close();
    expect(broker.physicalReadCount).toBe(3);
  });

  it('closes deterministically without waiting for an abort-resistant read or source cleanup', async () => {
    const [brokerPort, clientPort] = portPair();
    const close = vi.fn(() => new Promise<void>(() => undefined));
    const source = encodedSource(() => new Promise<Uint8Array>(() => undefined), { close });
    const broker = new EncodedSourcePortBroker({
      source,
      port: asPort(brokerPort),
      generation: 5,
    });
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 5,
      size: source.size,
    });
    const read = client.readAt(0, 1, new AbortController().signal);

    await expect(client.close()).resolves.toBeUndefined();
    await expect(read).rejects.toBeInstanceOf(EncodedSourceClosedError);
    expect(client.closed).toBe(true);
    expect(broker.closed).toBe(true);
    expect(broker.physicalReadCount).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('maps source failures to fixed error codes without crossing arbitrary text', async () => {
    const [brokerPort, clientPort] = portPair();
    const source = encodedSource(async () => {
      throw new Error('secret storage endpoint and token');
    });
    const broker = new EncodedSourcePortBroker({
      source,
      port: asPort(brokerPort),
      generation: 6,
    });
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 6,
      size: source.size,
    });

    const error = await client.readAt(0, 1, new AbortController().signal).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(EncodedSourcePortError);
    expect(error).toMatchObject({ code: 'read-failed' });
    expect(String(error)).not.toContain('secret');
    const response = brokerPort.sent.at(-1) as Record<string, unknown>;
    expect(Object.keys(response).sort()).toEqual([
      'code',
      'decoderGeneration',
      'generation',
      'length',
      'offset',
      'requestId',
      'type',
    ]);
    expect(response).not.toHaveProperty('message');

    await client.close();
    broker.close();
  });

  it('makes a broker postMessage failure close only that exact broker', async () => {
    const [brokerPort, clientPort] = portPair();
    const close = vi.fn(async () => undefined);
    const source = encodedSource(async () => Uint8Array.of(9), { close });
    const broker = new EncodedSourcePortBroker({
      source,
      port: asPort(brokerPort),
      generation: 8,
    });
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 8,
      size: source.size,
    });
    brokerPort.failPost = true;
    const orphanedRead = client.readAt(0, 1, new AbortController().signal);
    void orphanedRead.catch(() => undefined);
    await flushTasks();

    expect(broker.closed).toBe(true);
    expect(brokerPort.closed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(client.closed).toBe(false);
    await client.close();
    await expect(orphanedRead).rejects.toBeInstanceOf(EncodedSourceClosedError);
  });

  it('rejects accessor commands without invoking their getters', () => {
    const [brokerPort, remotePort] = portPair();
    const readAt = vi.fn(async () => Uint8Array.of(1));
    const broker = new EncodedSourcePortBroker({
      source: encodedSource(readAt),
      port: asPort(brokerPort),
      generation: 9,
    });
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'type', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'encoded-source:read';
      },
    });

    remotePort.postMessage(hostile);
    expect(getterCalls).toBe(0);
    expect(readAt).not.toHaveBeenCalled();
    expect(broker.closed).toBe(true);
  });

  it('quarantines Proxy parser reentry before an outer broker command can start a read', () => {
    const [brokerPort, remotePort] = portPair();
    const readAt = vi.fn(async () => Uint8Array.of(1));
    const broker = new EncodedSourcePortBroker({
      source: encodedSource(readAt),
      port: asPort(brokerPort),
      generation: 10,
    });
    const outer = command({
      type: 'encoded-source:read',
      generation: 10,
      decoderGeneration: 1,
      requestId: 1,
      offset: 0,
      length: 1,
    });
    let reentered = false;
    const proxy = new Proxy(outer, {
      ownKeys(target) {
        if (!reentered) {
          reentered = true;
          remotePort.postMessage(command({ type: 'encoded-source:close', generation: 10 }));
        }
        return Reflect.ownKeys(target);
      },
    });

    remotePort.postMessage(proxy);
    expect(broker.closed).toBe(true);
    expect(readAt).not.toHaveBeenCalled();
    expect(broker.physicalReadCount).toBe(0);
  });

  it('closes on a mismatched source lifetime or non-monotonic request ID reuse', () => {
    const [brokerPort, remotePort] = portPair();
    const broker = new EncodedSourcePortBroker({
      source: encodedSource(() => new Promise<Uint8Array>(() => undefined)),
      port: asPort(brokerPort),
      generation: 11,
    });
    remotePort.postMessage(
      command({
        type: 'encoded-source:read',
        generation: 10,
        decoderGeneration: 1,
        requestId: 99,
        offset: 0,
        length: 1,
      }),
    );
    expect(broker.closed).toBe(true);
    expect(broker.physicalReadCount).toBe(0);

    const [nextBrokerPort, nextRemotePort] = portPair();
    const nextBroker = new EncodedSourcePortBroker({
      source: encodedSource(() => new Promise<Uint8Array>(() => undefined)),
      port: asPort(nextBrokerPort),
      generation: 11,
    });
    nextRemotePort.postMessage(
      command({
        type: 'encoded-source:read',
        generation: 11,
        decoderGeneration: 1,
        requestId: 2,
        offset: 0,
        length: 1,
      }),
    );
    expect(nextBroker.physicalReadCount).toBe(1);
    nextRemotePort.postMessage(
      command({
        type: 'encoded-source:read',
        generation: 11,
        decoderGeneration: 1,
        requestId: 2,
        offset: 1,
        length: 1,
      }),
    );
    expect(nextBroker.closed).toBe(true);
    expect(nextBroker.physicalReadCount).toBe(1);
  });

  it('ignores an exact stale completion but closes on future or mismatched correlation', async () => {
    const [clientPort, remotePort] = portPair();
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 12,
      size: 16,
    });
    const controller = new AbortController();
    const abandoned = client.readAt(0, 1, controller.signal);
    controller.abort(new DOMException('done', 'AbortError'));
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });

    remotePort.postMessage(
      command({
        type: 'encoded-source:result',
        generation: 12,
        decoderGeneration: 1,
        requestId: 1,
        offset: 0,
        length: 1,
        payload: Uint8Array.of(1).buffer,
      }),
    );
    expect(client.closed).toBe(false);

    const active = client.readAt(1, 1, new AbortController().signal);
    remotePort.postMessage(
      command({
        type: 'encoded-source:result',
        generation: 12,
        decoderGeneration: 1,
        requestId: 2,
        offset: 2,
        length: 1,
        payload: Uint8Array.of(2).buffer,
      }),
    );
    await expect(active).rejects.toMatchObject({ code: 'protocol' });
    expect(client.closed).toBe(true);
  });

  it('rejects hostile response getters and Proxy reentry without publishing bytes', async () => {
    const [clientPort, remotePort] = portPair();
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 13,
      size: 16,
    });
    const read = client.readAt(0, 1, new AbortController().signal);
    let getterCalls = 0;
    const accessorResponse = Object.defineProperty({}, 'type', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'encoded-source:result';
      },
    });
    remotePort.postMessage(accessorResponse);
    await expect(read).rejects.toMatchObject({ code: 'protocol' });
    expect(getterCalls).toBe(0);

    const [nextClientPort, nextRemotePort] = portPair();
    const nextClient = new EncodedSourcePortClient({
      port: asPort(nextClientPort),
      generation: 14,
      size: 16,
    });
    const nextRead = nextClient.readAt(0, 1, new AbortController().signal);
    const outer = command({
      type: 'encoded-source:result',
      generation: 14,
      decoderGeneration: 1,
      requestId: 1,
      offset: 0,
      length: 1,
      payload: Uint8Array.of(7).buffer,
    });
    let reentered = false;
    const proxy = new Proxy(outer, {
      ownKeys(target) {
        if (!reentered) {
          reentered = true;
          nextRemotePort.postMessage(
            command({
              type: 'encoded-source:error',
              generation: 14,
              decoderGeneration: 1,
              requestId: 1,
              offset: 0,
              length: 1,
              code: 'read-failed',
            }),
          );
        }
        return Reflect.ownKeys(target);
      },
    });
    nextRemotePort.postMessage(proxy);
    await expect(nextRead).rejects.toMatchObject({ code: 'protocol' });
    expect(nextClient.closed).toBe(true);

    const [payloadClientPort, payloadRemotePort] = portPair();
    const payloadClient = new EncodedSourcePortClient({
      port: asPort(payloadClientPort),
      generation: 16,
      size: 16,
    });
    const payloadRead = payloadClient.readAt(0, 1, new AbortController().signal);
    payloadRemotePort.postMessage(
      command({
        type: 'encoded-source:result',
        generation: 16,
        decoderGeneration: 1,
        requestId: 1,
        offset: 0,
        length: 1,
        payload: new Proxy(new ArrayBuffer(1), {}),
      }),
    );
    await expect(payloadRead).rejects.toMatchObject({ code: 'protocol' });
    expect(payloadClient.closed).toBe(true);
  });

  it('is unaffected by inherited value/toJSON pollution', async () => {
    const originalValue = Object.getOwnPropertyDescriptor(Object.prototype, 'value');
    const originalToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get() {
        throw new Error('prototype toJSON getter must not run');
      },
    });
    Object.defineProperty(Object.prototype, 'value', {
      configurable: true,
      get() {
        throw new Error('prototype value getter must not run');
      },
    });

    let result: Uint8Array | null = null;
    let failure: unknown = null;
    try {
      const [brokerPort, clientPort] = portPair();
      const source = encodedSource(async () => Uint8Array.of(42));
      const broker = new EncodedSourcePortBroker({
        source,
        port: asPort(brokerPort),
        generation: 15,
      });
      const client = new EncodedSourcePortClient({
        port: asPort(clientPort),
        generation: 15,
        size: source.size,
      });
      result = await client.readAt(0, 1, new AbortController().signal);
      await client.close();
      broker.close();
    } catch (error) {
      failure = error;
    } finally {
      if (originalValue) Object.defineProperty(Object.prototype, 'value', originalValue);
      else delete (Object.prototype as Record<string, unknown>).value;
      if (originalToJSON) Object.defineProperty(Object.prototype, 'toJSON', originalToJSON);
      else delete (Object.prototype as Record<string, unknown>).toJSON;
    }
    expect(failure).toBeNull();
    expect(result).toEqual(Uint8Array.of(42));
  });

  it('closes both real MessageChannel endpoints and aborts source work on peer close', async () => {
    const channel = new MessageChannel();
    const close = vi.fn(async () => undefined);
    let physicalSignal: AbortSignal | null = null;
    const source = encodedSource(
      (_offset, _length, signal) => {
        physicalSignal = signal;
        return new Promise<Uint8Array>(() => undefined);
      },
      { close },
    );
    const broker = new EncodedSourcePortBroker({
      source,
      port: channel.port1,
      generation: 201,
    });
    const client = new EncodedSourcePortClient({
      port: channel.port2,
      generation: 201,
      size: source.size,
      responseTimeoutMs: 100,
    });
    const read = client.readAt(0, 1, new AbortController().signal);
    await vi.waitFor(() => expect(physicalSignal).not.toBeNull());

    channel.port2.close();

    await expect(read).rejects.toMatchObject({ code: 'closed' });
    await vi.waitFor(() => {
      expect(client.closed).toBe(true);
      expect(broker.closed).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
      expect(physicalSignal?.aborted).toBe(true);
    });
    expect(broker.physicalReadCount).toBe(1);
  });

  it('treats messageerror as fatal on both sides and rejects pending reads', async () => {
    const [brokerPort, clientPort] = portPair();
    const close = vi.fn(async () => undefined);
    let physicalSignal: AbortSignal | null = null;
    const source = encodedSource(
      (_offset, _length, signal) => {
        physicalSignal = signal;
        return new Promise<Uint8Array>(() => undefined);
      },
      { close },
    );
    const broker = new EncodedSourcePortBroker({
      source,
      port: asPort(brokerPort),
      generation: 202,
    });
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 202,
      size: source.size,
    });
    const read = client.readAt(0, 1, new AbortController().signal);
    await flushTasks();

    brokerPort.emitLifecycle('messageerror');
    clientPort.emitLifecycle('messageerror');

    await expect(read).rejects.toMatchObject({ code: 'closed' });
    expect(broker.closed).toBe(true);
    expect(client.closed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(physicalSignal?.aborted).toBe(true);
  });

  it('times out a silently disentangled port even when postMessage reports success', async () => {
    const [clientPort] = portPair();
    clientPort.peer = null;
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 203,
      size: 16,
      responseTimeoutMs: 5,
    });

    await expect(client.readAt(0, 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'closed',
    });
    expect(clientPort.sent).toHaveLength(1);
    expect(client.closed).toBe(true);
  });

  it('keeps one physical-read ledger and source across decoder seek generations', async () => {
    const [brokerPort, clientPort] = portPair();
    const close = vi.fn(async () => undefined);
    const readAt = vi.fn(() => new Promise<Uint8Array>(() => undefined));
    const source = encodedSource(readAt, { close });
    const broker = new EncodedSourcePortBroker({
      source,
      port: asPort(brokerPort),
      generation: 204,
      maxPhysicalReads: 2,
    });
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 204,
      size: source.size,
    });

    const first = client.readAt(0, 1, new AbortController().signal);
    await flushTasks();
    expect(client.beginDecoderGeneration()).toBe(2);
    await expect(first).rejects.toMatchObject({ code: 'aborted' });
    expect(client.cancelledReadCount).toBe(0);
    expect(broker.physicalReadCount).toBe(1);

    const second = client.readAt(1, 1, new AbortController().signal);
    await flushTasks();
    expect(client.beginDecoderGeneration()).toBe(3);
    await expect(second).rejects.toMatchObject({ code: 'aborted' });
    expect(broker.physicalReadCount).toBe(2);
    expect(close).not.toHaveBeenCalled();

    await expect(client.readAt(2, 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'busy',
    });
    await flushTasks();
    expect(readAt).toHaveBeenCalledTimes(2);
    expect(broker.physicalReadCount).toBe(2);
    expect(client.decoderGeneration).toBe(3);
    expect(close).not.toHaveBeenCalled();

    await client.close();
    expect(broker.closed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('requires own enumerable data properties and rejects functions or exotic records', async () => {
    const [brokerPort, remotePort] = portPair();
    const readAt = vi.fn(async () => Uint8Array.of(1));
    const broker = new EncodedSourcePortBroker({
      source: encodedSource(readAt),
      port: asPort(brokerPort),
      generation: 205,
    });
    const nonEnumerable = command({
      type: 'encoded-source:read',
      generation: 205,
      decoderGeneration: 1,
      requestId: 1,
      offset: 0,
      length: 1,
    });
    Object.defineProperty(nonEnumerable, 'length', { value: 1, enumerable: false });
    remotePort.postMessage(nonEnumerable);
    expect(broker.closed).toBe(true);
    expect(readAt).not.toHaveBeenCalled();

    const [functionBrokerPort, functionRemotePort] = portPair();
    const functionBroker = new EncodedSourcePortBroker({
      source: encodedSource(readAt),
      port: asPort(functionBrokerPort),
      generation: 206,
    });
    const exotic = Object.assign(() => undefined, {
      type: 'encoded-source:close',
      generation: 206,
    });
    functionRemotePort.postMessage(exotic);
    expect(functionBroker.closed).toBe(true);

    const [clientPort, responsePort] = portPair();
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 207,
      size: 16,
    });
    const pending = client.readAt(0, 1, new AbortController().signal);
    const response = command({
      type: 'encoded-source:result',
      generation: 207,
      decoderGeneration: 1,
      requestId: 1,
      offset: 0,
      length: 1,
      payload: Uint8Array.of(1).buffer,
    });
    Object.defineProperty(response, 'offset', { value: 0, enumerable: false });
    responsePort.postMessage(response);
    await expect(pending).rejects.toMatchObject({ code: 'protocol' });
    expect(client.closed).toBe(true);
  });

  it('copies from a validated ArrayBuffer without reading a shadowed byteLength property', async () => {
    const [clientPort, responsePort] = portPair();
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 208,
      size: 16,
    });
    const pending = client.readAt(0, 1, new AbortController().signal);
    const payload = Uint8Array.of(77).buffer;
    let shadowGetterCalls = 0;
    Object.defineProperty(payload, 'byteLength', {
      configurable: true,
      get() {
        shadowGetterCalls += 1;
        return 999;
      },
    });
    responsePort.postMessage(
      command({
        type: 'encoded-source:result',
        generation: 208,
        decoderGeneration: 1,
        requestId: 1,
        offset: 0,
        length: 1,
        payload,
      }),
    );

    await expect(pending).resolves.toEqual(Uint8Array.of(77));
    expect(shadowGetterCalls).toBe(0);
    await client.close();
  });

  it('bounds exact cancellation tombstones and rejects mismatches or post-ACK completions', async () => {
    const [boundedPort] = portPair();
    boundedPort.peer = null;
    const bounded = new EncodedSourcePortClient({
      port: asPort(boundedPort),
      generation: 209,
      size: 16,
      maxCancelledReads: 2,
    });
    for (let index = 0; index < 3; index += 1) {
      const controller = new AbortController();
      const read = bounded.readAt(index, 1, controller.signal);
      controller.abort(new DOMException('cancel', 'AbortError'));
      await expect(read).rejects.toMatchObject({ name: 'AbortError' });
    }
    expect(bounded.closed).toBe(true);
    expect(bounded.cancelledReadCount).toBe(0);

    const [mismatchPort, mismatchRemote] = portPair();
    const mismatch = new EncodedSourcePortClient({
      port: asPort(mismatchPort),
      generation: 210,
      size: 16,
    });
    const mismatchController = new AbortController();
    const mismatchRead = mismatch.readAt(0, 1, mismatchController.signal);
    mismatchController.abort(new DOMException('cancel', 'AbortError'));
    await expect(mismatchRead).rejects.toMatchObject({ name: 'AbortError' });
    mismatchRemote.postMessage(
      command({
        type: 'encoded-source:result',
        generation: 210,
        decoderGeneration: 1,
        requestId: 1,
        offset: 1,
        length: 1,
        payload: Uint8Array.of(1).buffer,
      }),
    );
    expect(mismatch.closed).toBe(true);

    const [ackedPort, ackedRemote] = portPair();
    const acked = new EncodedSourcePortClient({
      port: asPort(ackedPort),
      generation: 211,
      size: 16,
    });
    const ackedController = new AbortController();
    const ackedRead = acked.readAt(0, 1, ackedController.signal);
    ackedController.abort(new DOMException('cancel', 'AbortError'));
    await expect(ackedRead).rejects.toMatchObject({ name: 'AbortError' });
    ackedRemote.postMessage(
      command({
        type: 'encoded-source:cancel-ack',
        generation: 211,
        decoderGeneration: 1,
        requestId: 1,
        offset: 0,
        length: 1,
      }),
    );
    expect(acked.cancelledReadCount).toBe(0);
    ackedRemote.postMessage(
      command({
        type: 'encoded-source:result',
        generation: 211,
        decoderGeneration: 1,
        requestId: 1,
        offset: 0,
        length: 1,
        payload: Uint8Array.of(1).buffer,
      }),
    );
    expect(acked.closed).toBe(true);
  });

  it('emits at most one settlement ACK for duplicate cancelled completions', async () => {
    const [clientPort, remotePort] = portPair();
    const client = new EncodedSourcePortClient({
      port: asPort(clientPort),
      generation: 212,
      size: 16,
    });
    const controller = new AbortController();
    const read = client.readAt(0, 1, controller.signal);
    controller.abort(new DOMException('cancel', 'AbortError'));
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });

    const completion = command({
      type: 'encoded-source:result',
      generation: 212,
      decoderGeneration: 1,
      requestId: 1,
      offset: 0,
      length: 1,
      payload: Uint8Array.of(1).buffer,
    });
    for (let index = 0; index < 1_000; index += 1) remotePort.postMessage(completion);
    await flushTasks();

    expect(client.closed).toBe(false);
    expect(
      clientPort.sent.filter(
        (value) => (value as Record<string, unknown>).type === 'encoded-source:settle-ack',
      ),
    ).toHaveLength(1);
    await client.close();
  });

  it('emits at most one cancel ACK for duplicate exact broker cancellation', async () => {
    const [brokerPort, remotePort] = portPair();
    const broker = new EncodedSourcePortBroker({
      source: encodedSource(async () => Uint8Array.of(9)),
      port: asPort(brokerPort),
      generation: 213,
    });
    remotePort.postMessage(
      command({
        type: 'encoded-source:read',
        generation: 213,
        decoderGeneration: 1,
        requestId: 1,
        offset: 0,
        length: 1,
      }),
    );
    await flushTasks();
    const cancellation = command({
      type: 'encoded-source:cancel',
      generation: 213,
      decoderGeneration: 1,
      requestId: 1,
      offset: 0,
      length: 1,
    });
    for (let index = 0; index < 1_000; index += 1) remotePort.postMessage(cancellation);

    expect(broker.closed).toBe(false);
    expect(
      brokerPort.sent.filter(
        (value) => (value as Record<string, unknown>).type === 'encoded-source:cancel-ack',
      ),
    ).toHaveLength(1);
    await broker.close();
  });
});
