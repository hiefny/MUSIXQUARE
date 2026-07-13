import {
  AacDecoderBackendIntegrityError,
  AacDecoderBackendUnavailableError,
  aacCoreSampleRateHz,
  snapshotAacDecoderBackendGenerationOptions,
  type AacDecoderBackend,
  type AacDecoderBackendGenerationOptions,
  type AacDecoderBackendId,
} from './decoder-backend.ts';
import { createAacWebCodecsBatchDecoder } from './webcodecs-batch-decoder.ts';

const trustedAbortAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const trustedAbortReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get;

interface AbortState {
  readonly aborted: boolean;
  readonly reason: unknown;
}

function requireAbortSignal(value: unknown): AbortSignal {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    typeof trustedAbortAborted !== 'function'
  ) {
    throw new TypeError('AAC decoder backend factory requires an exact AbortSignal');
  }
  try {
    Reflect.apply(trustedAbortAborted, value, []);
  } catch (cause) {
    throw new TypeError('AAC decoder backend factory requires an exact AbortSignal', { cause });
  }
  return value as AbortSignal;
}

function readAbortState(signal: AbortSignal): Readonly<AbortState> {
  let aborted: unknown;
  try {
    aborted = trustedAbortAborted ? Reflect.apply(trustedAbortAborted, signal, []) : signal.aborted;
  } catch (cause) {
    return Object.freeze({ aborted: true, reason: cause });
  }
  if (aborted !== true) return Object.freeze({ aborted: false, reason: undefined });

  let reason: unknown;
  try {
    reason = trustedAbortReason ? Reflect.apply(trustedAbortReason, signal, []) : undefined;
  } catch (cause) {
    reason = cause;
  }
  return Object.freeze({
    aborted: true,
    reason:
      reason === undefined
        ? new DOMException('The AAC decoder backend selection was aborted', 'AbortError')
        : reason,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  const state = readAbortState(signal);
  if (state.aborted) throw state.reason;
}

function throwAbortInstead(signal: AbortSignal, fallback: unknown): never {
  const state = readAbortState(signal);
  throw state.aborted ? state.reason : fallback;
}

interface BackendCleanupContext {
  readonly authority: unknown;
  closeRead: boolean;
  close: unknown;
  attempted: boolean;
}

function createBackendCleanupContext(backend: unknown): BackendCleanupContext {
  return { authority: backend, closeRead: false, close: undefined, attempted: false };
}

function readBackendClose(context: BackendCleanupContext): unknown {
  if (context.closeRead) return context.close;
  context.closeRead = true;
  context.close = Reflect.get(context.authority as object, 'close');
  return context.close;
}

function closeBackendBestEffort(context: BackendCleanupContext): void {
  if (context.attempted) return;
  context.attempted = true;
  try {
    if (
      (typeof context.authority !== 'object' && typeof context.authority !== 'function') ||
      context.authority === null
    ) {
      return;
    }
    const close = readBackendClose(context);
    if (typeof close === 'function') Reflect.apply(close, context.authority, []);
  } catch {
    // Selection/abort failure is authoritative; cleanup must not replace it.
  }
}

function validateBackendPostcondition(
  backend: unknown,
  backendId: AacDecoderBackendId,
  options: Readonly<AacDecoderBackendGenerationOptions>,
  cleanup: BackendCleanupContext,
): asserts backend is AacDecoderBackend {
  if ((typeof backend !== 'object' && typeof backend !== 'function') || backend === null) {
    throw new AacDecoderBackendIntegrityError('AAC backend creator returned a non-object result');
  }

  let close: unknown;
  let decodeBatch: unknown;
  let id: unknown;
  let coreSampleRateHz: unknown;
  let channels: unknown;
  let firstAccessUnitOrdinal: unknown;
  try {
    close = readBackendClose(cleanup);
    decodeBatch = Reflect.get(backend, 'decodeBatch');
    id = Reflect.get(backend, 'id');
    coreSampleRateHz = Reflect.get(backend, 'coreSampleRateHz');
    channels = Reflect.get(backend, 'channels');
    firstAccessUnitOrdinal = Reflect.get(backend, 'firstAccessUnitOrdinal');
  } catch (cause) {
    throw new AacDecoderBackendIntegrityError(
      'AAC backend result could not be inspected safely',
      cause,
    );
  }

  if (
    typeof close !== 'function' ||
    typeof decodeBatch !== 'function' ||
    id !== backendId ||
    !Object.is(coreSampleRateHz, aacCoreSampleRateHz(options.coreConfiguration)) ||
    !Object.is(channels, options.coreConfiguration.channelConfiguration) ||
    !Object.is(firstAccessUnitOrdinal, options.firstAccessUnitOrdinal)
  ) {
    throw new AacDecoderBackendIntegrityError(
      'AAC backend result contradicts its selected generation contract',
    );
  }
}

/**
 * Select exactly one admitted AAC decoder backend for a fresh generation.
 *
 * This boundary never substitutes another backend. A failed WebCodecs cohort
 * stays failed, and the future Symphonia artifact remains unavailable until a
 * separate admission checkpoint explicitly enables it.
 */
export async function createAacDecoderBackend(
  backendId: AacDecoderBackendId,
  optionsValue: AacDecoderBackendGenerationOptions,
  signalValue: AbortSignal,
): Promise<AacDecoderBackend> {
  const signal = requireAbortSignal(signalValue);
  throwIfAborted(signal);

  if (backendId !== 'webcodecs' && backendId !== 'symphonia-wasm') {
    throw new TypeError('AAC decoder backend id is invalid');
  }

  let options: Readonly<AacDecoderBackendGenerationOptions>;
  try {
    options = snapshotAacDecoderBackendGenerationOptions(optionsValue);
  } catch (cause) {
    throwAbortInstead(signal, cause);
  }
  throwIfAborted(signal);

  if (backendId === 'symphonia-wasm') {
    throw new AacDecoderBackendUnavailableError(
      'The Symphonia WASM AAC decoder backend has not been admitted',
    );
  }

  let backend: AacDecoderBackend;
  try {
    backend = await createAacWebCodecsBatchDecoder(options, signal);
  } catch (cause) {
    throwAbortInstead(signal, cause);
  }

  const cleanup = createBackendCleanupContext(backend);
  const postResolutionAbort = readAbortState(signal);
  if (postResolutionAbort.aborted) {
    closeBackendBestEffort(cleanup);
    throw postResolutionAbort.reason;
  }

  try {
    validateBackendPostcondition(backend, backendId, options, cleanup);
  } catch (cause) {
    closeBackendBestEffort(cleanup);
    throwAbortInstead(signal, cause);
  }

  const postValidationAbort = readAbortState(signal);
  if (postValidationAbort.aborted) {
    closeBackendBestEffort(cleanup);
    throw postValidationAbort.reason;
  }
  return backend;
}
