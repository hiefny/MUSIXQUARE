import {
  EncodedSourceBusyError,
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
  type EncodedAudioSource,
  type EncodedAudioSourceKind,
  type EncodedAudioSourceMetadata,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  validateExactRead,
} from './encoded-audio-source.ts';

const SOURCE_KINDS = new Set<EncodedAudioSourceKind>(['blob', 'peer-range', 'r2-records']);
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) as object | null;
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
const arrayBufferIsView = ArrayBuffer.isView;
const uint8ArraySet = Uint8Array.prototype.set;
const MAX_METADATA_NAME_LENGTH = 512;
const MAX_METADATA_MIME_LENGTH = 128;
const MIME_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
const SOURCE_VIEW_MAX_PHYSICAL_READS = 8;

interface EncodedAudioSourceSnapshot {
  readonly kind: EncodedAudioSourceKind;
  readonly size: number;
  readonly identity: string;
  readonly metadata: Readonly<EncodedAudioSourceMetadata>;
  readonly readAt: EncodedAudioSource['readAt'];
  readonly close: EncodedAudioSource['close'];
}

export function snapshotEncodedAudioSource(source: EncodedAudioSource): EncodedAudioSourceSnapshot {
  try {
    if (source === null || (typeof source !== 'object' && typeof source !== 'function')) {
      throw new TypeError('Encoded audio source is required');
    }
    const kind = Reflect.get(source, 'kind') as unknown;
    const size = Reflect.get(source, 'size') as unknown;
    const identity = Reflect.get(source, 'identity') as unknown;
    const metadata = snapshotEncodedAudioSourceMetadata(Reflect.get(source, 'metadata'));
    const readAt = Reflect.get(source, 'readAt') as unknown;
    const close = Reflect.get(source, 'close') as unknown;

    if (!SOURCE_KINDS.has(kind as EncodedAudioSourceKind)) {
      throw new TypeError('Encoded source kind is invalid');
    }
    validateExactRead(size as number, 0, 0);
    if (!isEncodedAudioSourceIdentity(identity)) {
      throw new TypeError('Encoded source identity is invalid');
    }
    if (typeof readAt !== 'function' || typeof close !== 'function') {
      throw new TypeError('Encoded source methods are invalid');
    }

    return Object.freeze({
      kind: kind as EncodedAudioSourceKind,
      size: size as number,
      identity,
      metadata,
      readAt: (offset: number, length: number, signal: AbortSignal) =>
        Reflect.apply(readAt, source, [offset, length, signal]),
      close: () => Reflect.apply(close, source, []),
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw error;
    throw new TypeError('Encoded audio source could not be inspected', { cause: error });
  }
}

export function snapshotEncodedAudioSourceMetadata(
  value: unknown,
): Readonly<EncodedAudioSourceMetadata> {
  try {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      throw new TypeError('Encoded source metadata must be an object');
    }
    const name = Reflect.get(value, 'name') as unknown;
    const mime = Reflect.get(value, 'mime') as unknown;
    if (
      typeof name !== 'string' ||
      name.trim().length === 0 ||
      name.length > MAX_METADATA_NAME_LENGTH ||
      containsControlCharacter(name) ||
      hasUnpairedSurrogate(name)
    ) {
      throw new TypeError('Encoded source metadata name is invalid');
    }
    if (
      typeof mime !== 'string' ||
      mime.length > MAX_METADATA_MIME_LENGTH ||
      !MIME_PATTERN.test(mime)
    ) {
      throw new TypeError('Encoded source metadata mime is invalid');
    }
    return Object.freeze({ name, mime });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Encoded source metadata could not be inspected', { cause: error });
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function exactUint8ArrayByteLength(value: unknown): number | null {
  if (
    !typedArrayByteLengthGetter ||
    !typedArrayBufferGetter ||
    !typedArrayTagGetter ||
    !arrayBufferByteLengthGetter ||
    !arrayBufferIsView(value)
  ) {
    return null;
  }
  try {
    if (Reflect.apply(typedArrayTagGetter, value, []) !== 'Uint8Array') return null;
    const byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []) as number;
    const buffer = Reflect.apply(typedArrayBufferGetter, value, []) as unknown;
    // ArrayBuffer.prototype.byteLength rejects SharedArrayBuffer and detached storage.
    Reflect.apply(arrayBufferByteLengthGetter, buffer, []);
    return byteLength;
  } catch {
    return null;
  }
}

export function snapshotBoundedBytes(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  label: string,
): Uint8Array {
  const byteLength = readExactUint8ArrayByteLength(value, label);
  if (byteLength < minimumLength || byteLength > maximumLength) {
    throw new RangeError(`${label} must be ${minimumLength} to ${maximumLength} bytes`);
  }
  return snapshotExactBytes(value, byteLength, label);
}

export function readExactUint8ArrayByteLength(value: unknown, label: string): number {
  const byteLength = exactUint8ArrayByteLength(value);
  if (byteLength === null) throw new TypeError(`${label} must be a Uint8Array on local storage`);
  return byteLength;
}

function snapshotExactBytes(value: unknown, expectedLength: number, label: string): Uint8Array {
  if (exactUint8ArrayByteLength(value) !== expectedLength) {
    throw new EncodedSourceIntegrityError(
      `${label} did not contain exactly ${expectedLength} bytes`,
    );
  }
  const copy = new Uint8Array(expectedLength);
  try {
    Reflect.apply(uint8ArraySet, copy, [value, 0]);
  } catch {
    throw new EncodedSourceIntegrityError(`${label} bytes could not be copied`);
  }
  return copy;
}

export function safeAddSourceSize(left: number, right: number, label: string): number {
  validateExactRead(left, 0, 0);
  validateExactRead(right, 0, 0);
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new RangeError(`${label} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return sum;
}

function abortControllerFrom(controller: AbortController, signal: AbortSignal): void {
  if (!controller.signal.aborted) controller.abort(signal.reason);
}

function createAbortGate(signal: AbortSignal): {
  readonly promise: Promise<never>;
  readonly dispose: () => void;
} {
  let onAbort = (): void => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => signal.removeEventListener('abort', onAbort),
  };
}

interface AbortableExactReadOptions {
  readonly signal: AbortSignal;
  readonly expectedLength: number;
  readonly activeReads: Set<AbortController>;
  /** Retained until the real lower read settles, even after logical abort. */
  readonly physicalTasks: Set<Promise<Uint8Array>>;
  readonly isClosed: () => boolean;
  readonly read: (signal: AbortSignal) => Promise<unknown> | unknown;
  readonly label: string;
}

export function runAbortableExactRead(options: AbortableExactReadOptions): Promise<Uint8Array> {
  if (!(options.signal instanceof AbortSignal)) {
    return Promise.reject(new TypeError('Encoded source read signal must be an AbortSignal'));
  }
  if (options.isClosed()) return Promise.reject(new EncodedSourceClosedError());
  try {
    validateExactRead(options.expectedLength, 0, options.expectedLength);
    throwIfAborted(options.signal);
  } catch (error) {
    return Promise.reject(error);
  }
  if (options.physicalTasks.size >= SOURCE_VIEW_MAX_PHYSICAL_READS) {
    return Promise.reject(
      new EncodedSourceBusyError('Encoded source view physical read capacity is exhausted'),
    );
  }

  const controller = new AbortController();
  const onCallerAbort = (): void => abortControllerFrom(controller, options.signal);
  options.signal.addEventListener('abort', onCallerAbort, { once: true });
  options.activeReads.add(controller);
  if (options.signal.aborted) onCallerAbort();

  const readTask = Promise.resolve()
    .then(() => {
      throwIfAborted(controller.signal);
      if (options.isClosed()) throw new EncodedSourceClosedError();
      return options.read(controller.signal);
    })
    .then((value) => {
      throwIfAborted(controller.signal);
      if (options.isClosed()) throw new EncodedSourceClosedError();
      return snapshotExactBytes(value, options.expectedLength, options.label);
    });
  options.physicalTasks.add(readTask);
  void readTask.then(
    () => options.physicalTasks.delete(readTask),
    () => options.physicalTasks.delete(readTask),
  );
  const abortGate = createAbortGate(controller.signal);

  return Promise.race([readTask, abortGate.promise]).finally(() => {
    options.signal.removeEventListener('abort', onCallerAbort);
    abortGate.dispose();
    options.activeReads.delete(controller);
  });
}

export function closeReadControllers(activeReads: Set<AbortController>): void {
  const reason = new EncodedSourceClosedError();
  for (const controller of activeReads) {
    if (!controller.signal.aborted) controller.abort(reason);
  }
  activeReads.clear();
}
