import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AAC_CAPABILITY_PROBE_GENERATION,
  AAC_CAPABILITY_PROBE_PROTOCOL_VERSION,
  AAC_CAPABILITY_PROBE_TIMEOUT_MS,
  parseAacCapabilityProbeCommand,
  parseAacCapabilityProbeEvent,
  type AacCapabilityProbeCommand,
  type AacCapabilityProbeEvent,
} from '../capability-probe-protocol.ts';
import {
  probeAacWebCodecsAdtsFrameInWorker,
  type AacWorkerCapabilityProbeRuntime,
} from '../worker-capability-probe.ts';
import { AacWebCodecsIntegrityError, AacWebCodecsUnavailableError } from '../webcodecs-canary.ts';

function frame(): Uint8Array {
  return Uint8Array.of(0xff, 0xf1, 0x50, 0x80, 0x01, 0x3f, 0xfc, 0x11, 0x22);
}

function readyEvent(): AacCapabilityProbeEvent {
  return {
    protocolVersion: AAC_CAPABILITY_PROBE_PROTOCOL_VERSION,
    type: 'probe-ready',
    probeGeneration: AAC_CAPABILITY_PROBE_GENERATION,
  };
}

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly messages: AacCapabilityProbeCommand[] = [];
  readonly transferCounts: number[] = [];
  terminateCount = 0;
  postThrows = false;
  postFailure: unknown;
  onPost: ((message: AacCapabilityProbeCommand) => void) | null = null;

  postMessage(message: AacCapabilityProbeCommand, transfer?: readonly Transferable[]): void {
    if (this.postThrows) throw this.postFailure;
    const cloned = structuredClone(message);
    this.messages.push(cloned);
    this.transferCounts.push(transfer?.length ?? 0);
    this.onPost?.(cloned);
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }
}

function runtime(worker: FakeWorker, createWorker = vi.fn(() => worker as unknown as Worker)) {
  return {
    runtime: { createWorker } satisfies AacWorkerCapabilityProbeRuntime,
    createWorker,
  };
}

describe('AAC same-Worker capability probe', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clones one bounded frame without transfer and terminates exactly once on success', async () => {
    const input = frame();
    const expected = input.slice();
    const worker = new FakeWorker();
    worker.onPost = () => worker.emit(readyEvent());
    const harness = runtime(worker);

    await probeAacWebCodecsAdtsFrameInWorker(input, new AbortController().signal, harness.runtime);

    expect(harness.createWorker).toHaveBeenCalledOnce();
    expect(worker.messages).toHaveLength(1);
    expect(worker.messages[0]?.frame).toEqual(expected);
    expect(worker.messages[0]?.frame).not.toBe(input);
    expect(worker.transferCounts).toEqual([0]);
    expect(input).toEqual(expected);
    expect(worker.terminateCount).toBe(1);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();
  });

  it.each([
    ['unavailable', AacWebCodecsUnavailableError],
    ['integrity', AacWebCodecsIntegrityError],
    ['internal', AacWebCodecsUnavailableError],
  ] as const)('maps a strict %s terminal response and tears down once', async (code, ErrorType) => {
    const worker = new FakeWorker();
    const harness = runtime(worker);
    const operation = probeAacWebCodecsAdtsFrameInWorker(
      frame(),
      new AbortController().signal,
      harness.runtime,
    );
    worker.emit({
      protocolVersion: AAC_CAPABILITY_PROBE_PROTOCOL_VERSION,
      type: 'probe-error',
      probeGeneration: AAC_CAPABILITY_PROBE_GENERATION,
      code,
      message: `fixture ${code}`,
    });

    await expect(operation).rejects.toBeInstanceOf(ErrorType);
    expect(worker.terminateCount).toBe(1);
  });

  it('preserves abort authority before creation and while a native task is pending', async () => {
    const before = new AbortController();
    const beforeReason = Object.freeze({ phase: 'before-worker' });
    before.abort(beforeReason);
    const unused = runtime(new FakeWorker());
    await expect(
      probeAacWebCodecsAdtsFrameInWorker(frame(), before.signal, unused.runtime),
    ).rejects.toBe(beforeReason);
    expect(unused.createWorker).not.toHaveBeenCalled();

    const controller = new AbortController();
    const reason = Object.freeze({ phase: 'pending-worker' });
    const worker = new FakeWorker();
    const pending = runtime(worker);
    const operation = probeAacWebCodecsAdtsFrameInWorker(
      frame(),
      controller.signal,
      pending.runtime,
    );
    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
    expect(worker.terminateCount).toBe(1);

    worker.emit(readyEvent());
    expect(worker.terminateCount).toBe(1);
  });

  it('bounds a silent Worker admission and terminates the realm exactly once', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const harness = runtime(worker);
    const operation = probeAacWebCodecsAdtsFrameInWorker(
      frame(),
      new AbortController().signal,
      harness.runtime,
    );
    const rejected = expect(operation).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(AAC_CAPABILITY_PROBE_TIMEOUT_MS);
    await rejected;
    expect(worker.terminateCount).toBe(1);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
    expect(worker.onmessageerror).toBeNull();

    await vi.advanceTimersByTimeAsync(AAC_CAPABILITY_PROBE_TIMEOUT_MS);
    expect(worker.terminateCount).toBe(1);
  });

  it('uses trusted AbortSignal/EventTarget intrinsics despite shadowed instance fields', async () => {
    const controller = new AbortController();
    const signal = controller.signal as AbortSignal & Record<string, unknown>;
    Object.defineProperties(signal, {
      aborted: { configurable: true, value: false },
      reason: { configurable: true, value: 'shadow reason' },
      addEventListener: {
        configurable: true,
        value: () => {
          throw new Error('shadow addEventListener must not run');
        },
      },
      removeEventListener: {
        configurable: true,
        value: () => {
          throw new Error('shadow removeEventListener must not run');
        },
      },
    });
    const worker = new FakeWorker();
    const harness = runtime(worker);
    const reason = Object.freeze({ phase: 'trusted-abort-intrinsics' });
    const operation = probeAacWebCodecsAdtsFrameInWorker(frame(), signal, harness.runtime);

    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
    expect(worker.terminateCount).toBe(1);
  });

  it('fails closed on malformed events, message errors, and synchronous post failures', async () => {
    const malformedWorker = new FakeWorker();
    const malformed = runtime(malformedWorker);
    const malformedOperation = probeAacWebCodecsAdtsFrameInWorker(
      frame(),
      new AbortController().signal,
      malformed.runtime,
    );
    malformedWorker.emit({ ...readyEvent(), extra: true });
    await expect(malformedOperation).rejects.toBeInstanceOf(AacWebCodecsUnavailableError);
    expect(malformedWorker.terminateCount).toBe(1);

    const messageWorker = new FakeWorker();
    const message = runtime(messageWorker);
    const messageOperation = probeAacWebCodecsAdtsFrameInWorker(
      frame(),
      new AbortController().signal,
      message.runtime,
    );
    messageWorker.onmessageerror?.(new MessageEvent('messageerror'));
    await expect(messageOperation).rejects.toBeInstanceOf(AacWebCodecsUnavailableError);
    expect(messageWorker.terminateCount).toBe(1);

    const postWorker = new FakeWorker();
    const postFailure = new Error('post failed');
    postWorker.postThrows = true;
    postWorker.postFailure = postFailure;
    const post = runtime(postWorker);
    await expect(
      probeAacWebCodecsAdtsFrameInWorker(frame(), new AbortController().signal, post.runtime),
    ).rejects.toBe(postFailure);
    expect(postWorker.terminateCount).toBe(1);

    const undefinedWorker = new FakeWorker();
    undefinedWorker.postThrows = true;
    const undefinedPost = runtime(undefinedWorker);
    const resolutionSentinel = Symbol('resolved');
    const observed = await probeAacWebCodecsAdtsFrameInWorker(
      frame(),
      new AbortController().signal,
      undefinedPost.runtime,
    ).then(
      () => resolutionSentinel,
      (error: unknown) => error,
    );
    expect(observed).toBeUndefined();
    expect(undefinedWorker.terminateCount).toBe(1);
  });

  it('strictly snapshots commands and events without invoking accessors', () => {
    const input = frame();
    const command = parseAacCapabilityProbeCommand({
      protocolVersion: AAC_CAPABILITY_PROBE_PROTOCOL_VERSION,
      type: 'probe-adts-webcodecs',
      probeGeneration: AAC_CAPABILITY_PROBE_GENERATION,
      frame: input,
    });
    expect(command?.frame).toEqual(input);
    expect(command?.frame).not.toBe(input);
    expect(
      parseAacCapabilityProbeCommand({
        protocolVersion: AAC_CAPABILITY_PROBE_PROTOCOL_VERSION,
        type: 'probe-adts-webcodecs',
        probeGeneration: AAC_CAPABILITY_PROBE_GENERATION,
        frame: input,
        extra: true,
      }),
    ).toBeNull();

    let reads = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'protocolVersion', {
      enumerable: true,
      get() {
        reads += 1;
        return AAC_CAPABILITY_PROBE_PROTOCOL_VERSION;
      },
    });
    expect(parseAacCapabilityProbeCommand(accessor)).toBeNull();
    expect(reads).toBe(0);

    expect(parseAacCapabilityProbeEvent(readyEvent())).toEqual(readyEvent());
    expect(parseAacCapabilityProbeEvent({ ...readyEvent(), extra: true })).toBeNull();
  });
});
