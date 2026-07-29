import {
  FilePlaybackR2RecordDescriptorRegistry,
  canonicalizeFilePlaybackR2RecordDeliveryScope,
  canonicalizeFilePlaybackR2RecordDescriptorRef,
  sameFilePlaybackR2RecordDeliveryScope,
  type FilePlaybackR2RecordDeliveryScope,
  type FilePlaybackR2RecordDescriptorRef,
} from './file-playback-r2-record-descriptor.ts';
import type { EncodedAudioSource } from './sources/encoded-audio-source.ts';

type ExactRecord = Readonly<Record<string, unknown>>;

interface OpenRecord {
  readonly key: string;
  readonly scope: Readonly<FilePlaybackR2RecordDeliveryScope>;
  readonly descriptor: Readonly<FilePlaybackR2RecordDescriptorRef>;
  readonly controller: AbortController;
  readonly detachCallerAbort: () => void;
  source: EncodedAudioSource | null;
  sourceTransferred: boolean;
  sourceClosePromise: Promise<void> | null;
  retired: boolean;
  promise: Promise<EncodedAudioSource>;
  retirement: Promise<void> | null;
}

const OPEN_KEYS = Object.freeze(['scope', 'descriptor', 'signal'] as const);
const nativeAbortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;
const nativeAbortSignalReasonGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'reason',
)?.get;
const nativeAbortSignalThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const nativeAddEventListener = EventTarget.prototype.addEventListener;
const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
const nativeAbortControllerAbort = AbortController.prototype.abort;

function fail(code: string, cause?: unknown): never {
  throw new Error(code, cause === undefined ? undefined : { cause });
}

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): ExactRecord | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const expected = new Set(expectedKeys);
    if (
      ownKeys.length !== expected.size ||
      ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return null;
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function isNativeAbortSignal(value: unknown): value is AbortSignal {
  if (
    !nativeAbortSignalAbortedGetter ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return false;
  }
  try {
    return typeof Reflect.apply(nativeAbortSignalAbortedGetter, value, []) === 'boolean';
  } catch {
    return false;
  }
}

function signalIsAborted(signal: AbortSignal): boolean {
  if (!nativeAbortSignalAbortedGetter) fail('FILE_PLAYBACK_R2_RECORD_ABORT_RUNTIME_INVALID');
  return Reflect.apply(nativeAbortSignalAbortedGetter, signal, []) as boolean;
}

function signalReason(signal: AbortSignal): unknown {
  if (!nativeAbortSignalReasonGetter) return undefined;
  try {
    return Reflect.apply(nativeAbortSignalReasonGetter, signal, []);
  } catch {
    return undefined;
  }
}

function throwIfSignalAborted(signal: AbortSignal): void {
  Reflect.apply(nativeAbortSignalThrowIfAborted, signal, []);
}

function abortController(controller: AbortController, reason: unknown): void {
  Reflect.apply(nativeAbortControllerAbort, controller, [reason]);
}

function sameDescriptor(
  left: Readonly<FilePlaybackR2RecordDescriptorRef>,
  right: Readonly<FilePlaybackR2RecordDescriptorRef>,
): boolean {
  return (
    left.descriptorId === right.descriptorId &&
    left.descriptorVersion === right.descriptorVersion &&
    sameFilePlaybackR2RecordDeliveryScope(left.scope, right.scope)
  );
}

function canonicalOpen(value: unknown): {
  readonly scope: Readonly<FilePlaybackR2RecordDeliveryScope>;
  readonly descriptor: Readonly<FilePlaybackR2RecordDescriptorRef>;
  readonly signal: AbortSignal;
} {
  const snapshot = snapshotExactDataRecord(value, OPEN_KEYS);
  if (!snapshot || !isNativeAbortSignal(snapshot.signal)) {
    fail('FILE_PLAYBACK_R2_RECORD_OPEN_INVALID');
  }
  const scope = canonicalizeFilePlaybackR2RecordDeliveryScope(snapshot.scope);
  const descriptor = canonicalizeFilePlaybackR2RecordDescriptorRef(snapshot.descriptor);
  if (!sameFilePlaybackR2RecordDeliveryScope(scope, descriptor.scope)) {
    fail('FILE_PLAYBACK_R2_RECORD_OPEN_SCOPE_MISMATCH');
  }
  throwIfSignalAborted(snapshot.signal);
  return { scope, descriptor, signal: snapshot.signal };
}

function linkCallerAbort(caller: AbortSignal, controller: AbortController): () => void {
  const forward = (): void => {
    if (!signalIsAborted(controller.signal)) {
      abortController(
        controller,
        signalReason(caller) ?? new DOMException('R2 record delivery open aborted', 'AbortError'),
      );
    }
  };
  Reflect.apply(nativeAddEventListener, caller, ['abort', forward, { once: true }]);
  if (signalIsAborted(caller)) forward();
  return () => {
    Reflect.apply(nativeRemoveEventListener, caller, ['abort', forward]);
  };
}

function validPreflightBytes(value: unknown): value is Uint8Array {
  try {
    return value instanceof Uint8Array && value.byteLength === 1;
  } catch {
    return false;
  }
}

/**
 * Delivery-only provider for the V1-control bounded slice. It owns descriptor
 * resolution and source construction, but no room state, connection, or
 * renderer authority.
 */
class FilePlaybackR2RecordDeliveryProvider {
  readonly #registry: FilePlaybackR2RecordDescriptorRegistry;
  readonly #openByScope = new Map<string, OpenRecord>();

  constructor(registry: FilePlaybackR2RecordDescriptorRegistry) {
    if (!(registry instanceof FilePlaybackR2RecordDescriptorRegistry)) {
      fail('FILE_PLAYBACK_R2_RECORD_PROVIDER_REGISTRY_INVALID');
    }
    this.#registry = registry;
  }

  open(value: unknown): Promise<EncodedAudioSource> {
    let input: ReturnType<typeof canonicalOpen>;
    let key: string;
    try {
      input = canonicalOpen(value);
      this.#registry.assertUsable(input.scope, input.descriptor);
      key = this.#registry.scopeKey(input.scope);
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = this.#openByScope.get(key);
    if (existing) {
      if (!sameDescriptor(existing.descriptor, input.descriptor)) {
        return Promise.reject(new Error('FILE_PLAYBACK_R2_RECORD_OPEN_SCOPE_CONFLICT'));
      }
      return Promise.reject(new Error('FILE_PLAYBACK_R2_RECORD_OPEN_ALREADY_ACTIVE'));
    }

    const controller = new AbortController();
    const record: OpenRecord = {
      key,
      scope: input.scope,
      descriptor: input.descriptor,
      controller,
      detachCallerAbort: linkCallerAbort(input.signal, controller),
      source: null,
      sourceTransferred: false,
      sourceClosePromise: null,
      retired: false,
      promise: Promise.reject(new Error('FILE_PLAYBACK_R2_RECORD_OPEN_NOT_STARTED')),
      retirement: null,
    };
    // The placeholder promise is never observed and must not create an
    // unhandled rejection before the real operation is installed.
    void record.promise.catch(() => undefined);
    this.#openByScope.set(key, record);
    record.promise = this.#performOpen(record);
    return record.promise;
  }

  retire(scopeValue: unknown): Promise<void> {
    const scope = canonicalizeFilePlaybackR2RecordDeliveryScope(scopeValue);
    const key = this.#registry.scopeKey(scope);
    const record = this.#openByScope.get(key);
    const registryRetirement = this.#registry.retire(scope);
    if (!record) return registryRetirement;
    if (record.retirement) return record.retirement;

    record.retired = true;
    if (!signalIsAborted(record.controller.signal)) {
      abortController(
        record.controller,
        new DOMException('R2 record delivery scope retired', 'AbortError'),
      );
    }
    // Logical retirement is bounded by registry revocation, not by a transport
    // constructor that may ignore AbortSignal forever. Any source that appears
    // later remains owned by #performOpen and is closed in the background.
    void record.promise.catch(() => undefined);
    void this.#closeOwnedSource(record);
    record.retirement = (async () => {
      await registryRetirement;
      if (this.#openByScope.get(key) === record) this.#openByScope.delete(key);
    })();
    return record.retirement;
  }

  async #performOpen(record: OpenRecord): Promise<EncodedAudioSource> {
    try {
      const source = await this.#registry.createSource(
        record.scope,
        record.descriptor,
        record.controller.signal,
      );
      record.source = source;
      this.#assertCurrent(record);
      const probe = await source.readAt(0, 1, record.controller.signal);
      if (!validPreflightBytes(probe)) {
        fail('FILE_PLAYBACK_R2_RECORD_PREFLIGHT_INVALID');
      }
      this.#assertCurrent(record);
      this.#registry.assertUsable(record.scope, record.descriptor);
      record.sourceTransferred = true;
      record.source = null;
      if (this.#openByScope.get(record.key) === record) {
        this.#openByScope.delete(record.key);
      }
      return source;
    } catch (error) {
      await this.#closeOwnedSource(record);
      if (!record.retired && this.#openByScope.get(record.key) === record) {
        this.#openByScope.delete(record.key);
      }
      throw error;
    } finally {
      record.detachCallerAbort();
    }
  }

  #assertCurrent(record: OpenRecord): void {
    throwIfSignalAborted(record.controller.signal);
    if (record.retired || this.#openByScope.get(record.key) !== record) {
      fail('FILE_PLAYBACK_R2_RECORD_OPEN_SUPERSEDED');
    }
  }

  #closeOwnedSource(record: OpenRecord): Promise<void> {
    if (record.sourceTransferred || !record.source) {
      return record.sourceClosePromise ?? Promise.resolve();
    }
    if (record.sourceClosePromise) return record.sourceClosePromise;
    const source = record.source;
    record.source = null;
    record.sourceClosePromise = Promise.resolve()
      .then(() => source.close())
      .catch(() => undefined);
    return record.sourceClosePromise;
  }
}

/**
 * Phase-2 foundation seam. Product code deliberately cannot construct this
 * provider until the narrow V1 bridge owns its lifecycle.
 */
export { FilePlaybackR2RecordDeliveryProvider as FilePlaybackR2RecordDeliveryProviderForTests };
