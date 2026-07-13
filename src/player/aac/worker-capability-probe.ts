import {
  AAC_CAPABILITY_PROBE_GENERATION,
  AAC_CAPABILITY_PROBE_PROTOCOL_VERSION,
  AAC_CAPABILITY_PROBE_TIMEOUT_MS,
  parseAacCapabilityProbeEvent,
  type AacCapabilityProbeCommand,
} from './capability-probe-protocol.ts';
import { AacWebCodecsIntegrityError, AacWebCodecsUnavailableError } from './webcodecs-canary.ts';

const ADTS_MIN_FRAME_BYTES = 8;
const ADTS_MAX_FRAME_BYTES = 8_191;

export interface AacWorkerCapabilityProbeRuntime {
  /** A fresh instance of the same module Worker used by AAC playback. */
  readonly createWorker: () => Worker;
}

const Uint8ArrayIntrinsic = Uint8Array;
const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8ArrayIntrinsic.prototype) as object | null;
const typedArrayByteLengthGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get
  : undefined;
const typedArrayBufferGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
  : undefined;
const typedArrayTagGetter = typedArrayPrototype
  ? Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get
  : undefined;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const uint8ArraySet = Uint8ArrayIntrinsic.prototype.set;
const uint8ArrayFill = Uint8ArrayIntrinsic.prototype.fill;
const trustedAbortThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const trustedAbortAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const trustedAbortReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get;
const trustedEventTargetAdd = EventTarget.prototype.addEventListener;
const trustedEventTargetRemove = EventTarget.prototype.removeEventListener;

function snapshotFrame(value: unknown): Uint8Array {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value)
  ) {
    throw new TypeError('AAC capability frame must be a Uint8Array');
  }
  let byteLength: number;
  try {
    if (typedArrayTagGetter.call(value) !== 'Uint8Array') {
      throw new TypeError('not a Uint8Array');
    }
    byteLength = typedArrayByteLengthGetter.call(value);
    const buffer = typedArrayBufferGetter.call(value);
    arrayBufferByteLengthGetter.call(buffer);
  } catch (cause) {
    throw new TypeError('AAC capability frame must use readable, non-shared storage', { cause });
  }
  if (byteLength < ADTS_MIN_FRAME_BYTES || byteLength > ADTS_MAX_FRAME_BYTES) {
    throw new RangeError('AAC capability frame has an invalid bounded ADTS size');
  }
  const owned = new Uint8ArrayIntrinsic(byteLength);
  try {
    Reflect.apply(uint8ArraySet, owned, [value, 0]);
  } catch (cause) {
    throw new TypeError('AAC capability frame could not be copied', { cause });
  }
  return owned;
}

function clearBytes(bytes: Uint8Array): void {
  try {
    Reflect.apply(uint8ArrayFill, bytes, [0]);
  } catch {
    // The bounded command copy is already unreachable after terminal cleanup.
  }
}

function abortReason(signal: AbortSignal): unknown {
  let reason: unknown;
  try {
    reason = trustedAbortReason ? Reflect.apply(trustedAbortReason, signal, []) : undefined;
  } catch (error) {
    reason = error;
  }
  return reason === undefined
    ? new DOMException('AAC capability probe was aborted', 'AbortError')
    : reason;
}

function throwIfAborted(signal: AbortSignal): void {
  if (typeof trustedAbortThrowIfAborted === 'function') {
    Reflect.apply(trustedAbortThrowIfAborted, signal, []);
    return;
  }
  const aborted = trustedAbortAborted
    ? (Reflect.apply(trustedAbortAborted, signal, []) as unknown)
    : false;
  if (aborted === true) throw abortReason(signal);
}

function addAbortListener(signal: AbortSignal, listener: EventListener): void {
  Reflect.apply(trustedEventTargetAdd, signal, ['abort', listener, { once: true }]);
}

function removeAbortListener(signal: AbortSignal, listener: EventListener): void {
  Reflect.apply(trustedEventTargetRemove, signal, ['abort', listener]);
}

function errorFromWorker(code: 'unavailable' | 'integrity' | 'internal', message: string): Error {
  if (code === 'integrity') return new AacWebCodecsIntegrityError(message);
  return new AacWebCodecsUnavailableError(message);
}

/**
 * Run one bounded ADTS canary in the exact Dedicated Worker cohort used later
 * by playback. The frame is cloned rather than transferred, and the fresh
 * Worker is terminated on every success, failure, or abort path.
 */
export function probeAacWebCodecsAdtsFrameInWorker(
  frame: Uint8Array,
  signal: AbortSignal,
  runtimeValue: AacWorkerCapabilityProbeRuntime,
): Promise<void> {
  if (!(signal instanceof AbortSignal)) {
    return Promise.reject(new TypeError('AAC Worker capability probe requires an AbortSignal'));
  }
  if (
    (typeof runtimeValue !== 'object' && typeof runtimeValue !== 'function') ||
    runtimeValue === null
  ) {
    return Promise.reject(new TypeError('AAC Worker capability runtime is required'));
  }

  let createWorker: AacWorkerCapabilityProbeRuntime['createWorker'];
  try {
    createWorker = runtimeValue.createWorker;
  } catch (cause) {
    return Promise.reject(
      new TypeError('AAC Worker capability runtime could not be inspected', { cause }),
    );
  }
  if (typeof createWorker !== 'function') {
    return Promise.reject(new TypeError('AAC Worker capability runtime is incomplete'));
  }

  let commandFrame: Uint8Array;
  try {
    throwIfAborted(signal);
    commandFrame = snapshotFrame(frame);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise<void>((resolve, reject) => {
    let worker: Worker | null = null;
    let settled = false;
    let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | null = null;

    const terminateWorker = (): void => {
      const current = worker;
      worker = null;
      if (!current) return;
      try {
        current.onmessage = null;
        current.onerror = null;
        current.onmessageerror = null;
      } catch {
        // Termination remains authoritative over hostile injected setters.
      }
      try {
        current.terminate();
      } catch {
        // Native Worker termination is synchronous and non-throwing.
      }
    };

    const finish = (succeeded: boolean, error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) {
        globalThis.clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      try {
        removeAbortListener(signal, onAbort);
      } catch {
        // The exact signal remains externally owned.
      }
      terminateWorker();
      clearBytes(commandFrame);
      if (succeeded) resolve();
      else reject(error);
    };
    const onAbort = (): void => finish(false, abortReason(signal));

    try {
      throwIfAborted(signal);
      worker = Reflect.apply(createWorker, runtimeValue, []) as Worker;
      if (
        !worker ||
        typeof worker.postMessage !== 'function' ||
        typeof worker.terminate !== 'function'
      ) {
        throw new TypeError('AAC capability Worker factory returned an invalid Worker');
      }
      worker.onmessage = (event: MessageEvent<unknown>): void => {
        let message: ReturnType<typeof parseAacCapabilityProbeEvent>;
        try {
          message = parseAacCapabilityProbeEvent(event.data);
        } catch {
          message = null;
        }
        if (!message) {
          finish(
            false,
            new AacWebCodecsUnavailableError('AAC capability Worker returned invalid data'),
          );
          return;
        }
        if (message.type === 'probe-error') {
          finish(false, errorFromWorker(message.code, message.message));
          return;
        }
        finish(true);
      };
      worker.onerror = (): void => {
        finish(false, new AacWebCodecsUnavailableError('AAC capability Worker failed'));
      };
      worker.onmessageerror = (): void => {
        finish(false, new AacWebCodecsUnavailableError('AAC capability Worker message failed'));
      };
      addAbortListener(signal, onAbort);
      throwIfAborted(signal);

      timeoutHandle = globalThis.setTimeout(() => {
        finish(
          false,
          new AacWebCodecsUnavailableError('AAC capability Worker timed out during admission'),
        );
      }, AAC_CAPABILITY_PROBE_TIMEOUT_MS);

      const command: Readonly<AacCapabilityProbeCommand> = Object.freeze({
        protocolVersion: AAC_CAPABILITY_PROBE_PROTOCOL_VERSION,
        type: 'probe-adts-webcodecs',
        probeGeneration: AAC_CAPABILITY_PROBE_GENERATION,
        frame: commandFrame,
      });
      // Deliberately omit a transfer list. The bounded frame remains available
      // for deterministic local zeroing after structured clone completes.
      worker.postMessage(command);
      clearBytes(commandFrame);
      throwIfAborted(signal);
    } catch (error) {
      finish(false, error);
    }
  });
}
