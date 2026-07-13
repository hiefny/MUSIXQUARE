import { IsoBmffBoxReader } from '../mp4/box-reader.ts';
import {
  EncodedSourceBusyError,
  EncodedSourceIntegrityError,
} from '../sources/encoded-audio-source.ts';
import { rehydrateM4aChunkIndex, type M4aChunkIndex } from './chunk-index.ts';
import { validateM4aAacLcManifest, type M4aAacLcManifest } from './metadata.ts';
import {
  closeM4aRawAacAccessUnitReader,
  openSourceBoundM4aRawAacAccessUnitReader,
  type M4aRawAacAccessUnitReader,
} from './raw-aac-access-unit-reader.ts';
import {
  rehydrateM4aSampleSizeIndex,
  type M4aIndexSourceBinding,
  type M4aSampleSizeIndex,
} from './sample-size-index.ts';
import {
  M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS,
  createM4aAacStartPlan,
  type M4aAacStartPlan,
} from './start-plan.ts';
import { M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT, type M4aAacTimeline } from './timeline.ts';

export { M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS } from './start-plan.ts';

export interface M4aAacRuntimeInfo {
  readonly format: 'm4a-aac-lc';
  readonly sourceSize: number;
  readonly sourceIdentity: string;
  readonly codec: 'mp4a.40.2';
  readonly sampleRateHz: number;
  readonly channelCount: 1 | 2;
  readonly audioSpecificConfig: readonly number[];
  readonly accessUnitCount: number;
  readonly totalEncodedBytes: number;
  readonly timeline: Readonly<M4aAacTimeline>;
  /** Source metadata evidence only; it never weakens the product decoder policy. */
  readonly sourceRequiredPrerollAccessUnits: 1 | null;
  /** Product transform policy, independently fixed even when source evidence is absent. */
  readonly transformPrerollPolicyAccessUnits: 1;
}

/** Backward-compatible runtime name for the common logical start plan. */
export type M4aAacGenerationStartPlan = M4aAacStartPlan;

export interface M4aAacRuntime {
  readonly info: Readonly<M4aAacRuntimeInfo>;
  createGenerationStartPlan(mediaFrame: number): Readonly<M4aAacGenerationStartPlan>;
  /** Accept only an unchanged plan issued by this exact live runtime. */
  requireGenerationStartPlan(value: unknown): Readonly<M4aAacGenerationStartPlan>;
  /** Issue the runtime's sole bounded raw-AAC cursor at an exact generation plan. */
  openAccessUnitReader(plan: unknown, signal: AbortSignal): Promise<M4aRawAacAccessUnitReader>;
  /** Release runtime authority without closing the caller-owned encoded source. */
  close(): void;
}

interface RuntimeAuthority {
  reader: IsoBmffBoxReader | null;
  sampleSizes: Readonly<M4aSampleSizeIndex> | null;
  chunks: Readonly<M4aChunkIndex> | null;
  readonly info: Readonly<M4aAacRuntimeInfo>;
  readonly closedError: M4aAacRuntimeClosedError;
  closed: boolean;
  cursorIssued: boolean;
  cursorOpenFailure: unknown;
  hasCursorOpenFailure: boolean;
  openingCursor: RuntimeCursorOpenOperation | null;
  activeCursor: M4aRawAacAccessUnitReader | null;
}

interface RuntimeCursorOpenOperation {
  readonly controller: AbortController;
  readonly detachCallerAbort: () => void;
}

interface StartPlanAuthority {
  readonly runtime: M4aAacRuntime;
  readonly plan: Readonly<M4aAacGenerationStartPlan>;
}

const runtimeAuthorities = new WeakMap<object, RuntimeAuthority>();
const closedRuntimes = new WeakSet<object>();
const startPlanAuthorities = new WeakMap<object, StartPlanAuthority>();
const trustedAbortThrowIfAborted = AbortSignal.prototype.throwIfAborted;
const trustedAbortAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
const trustedAbortReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get;
const trustedEventTargetAdd = EventTarget.prototype.addEventListener;
const trustedEventTargetRemove = EventTarget.prototype.removeEventListener;

function readAbortReason(signal: AbortSignal): unknown {
  try {
    return trustedAbortReason ? Reflect.apply(trustedAbortReason, signal, []) : signal.reason;
  } catch (error) {
    return error;
  }
}

function isAborted(signal: AbortSignal): boolean {
  return trustedAbortAborted
    ? Reflect.apply(trustedAbortAborted, signal, []) === true
    : signal.aborted;
}

function throwIfRuntimeAborted(signal: AbortSignal): void {
  if (typeof trustedAbortThrowIfAborted === 'function') {
    Reflect.apply(trustedAbortThrowIfAborted, signal, []);
    return;
  }
  if (!isAborted(signal)) return;
  const reason = readAbortReason(signal);
  throw reason === undefined
    ? new DOMException('The M4A AAC runtime operation was aborted', 'AbortError')
    : reason;
}

export class M4aAacRuntimeError extends EncodedSourceIntegrityError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'M4aAacRuntimeError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

export class M4aAacRuntimeClosedError extends Error {
  constructor() {
    super('M4A AAC runtime is closed');
    this.name = 'M4aAacRuntimeClosedError';
  }
}

function runtimeError(message: string, cause?: unknown): M4aAacRuntimeError {
  return new M4aAacRuntimeError(message, cause);
}

function requireRuntimeAuthority(value: unknown): RuntimeAuthority {
  const isObject = value !== null && (typeof value === 'object' || typeof value === 'function');
  const authority = isObject ? runtimeAuthorities.get(value) : undefined;
  if (authority === undefined) {
    if (isObject && closedRuntimes.has(value)) throw new M4aAacRuntimeClosedError();
    throw new TypeError('M4A AAC runtime lacks module provenance');
  }
  return authority;
}

function createRuntimeInfo(manifest: Readonly<M4aAacLcManifest>): Readonly<M4aAacRuntimeInfo> {
  return Object.freeze({
    format: 'm4a-aac-lc',
    sourceSize: manifest.sourceSize,
    sourceIdentity: manifest.sourceIdentity,
    codec: 'mp4a.40.2',
    sampleRateHz: manifest.codec.sampleRateHz,
    channelCount: manifest.codec.channelCount,
    audioSpecificConfig: Object.freeze([...manifest.codec.audioSpecificConfig]),
    accessUnitCount: manifest.timeline.accessUnitCount,
    totalEncodedBytes: manifest.sampleSizes.totalEncodedBytes,
    timeline: manifest.timeline,
    sourceRequiredPrerollAccessUnits: manifest.rollRecovery?.requiredPrerollAccessUnits ?? null,
    transformPrerollPolicyAccessUnits: M4A_AAC_TRANSFORM_PREROLL_POLICY_ACCESS_UNITS,
  });
}

function assertFinalRuntimeGeometry(
  manifest: Readonly<M4aAacLcManifest>,
  sampleSizes: Readonly<M4aSampleSizeIndex>,
  chunks: Readonly<M4aChunkIndex>,
): void {
  if (
    sampleSizes.sampleCount !== manifest.timeline.accessUnitCount ||
    chunks.sampleCount !== manifest.timeline.accessUnitCount ||
    sampleSizes.sampleCount !== chunks.sampleCount
  ) {
    throw runtimeError('M4A runtime indexes contradict the manifest access-unit count');
  }
  if (sampleSizes.totalEncodedBytes !== manifest.sampleSizes.totalEncodedBytes) {
    throw runtimeError('M4A runtime sample bytes contradict the admitted manifest');
  }
  if (
    manifest.timeline.coreFramesPerAccessUnit !== M4A_AAC_CORE_FRAMES_PER_ACCESS_UNIT ||
    manifest.timeline.sampleRateHz !== manifest.codec.sampleRateHz
  ) {
    throw runtimeError('M4A runtime codec and timeline geometry are inconsistent');
  }
}

/**
 * Atomically reopen one transferable M4A manifest against its exact reader.
 *
 * The reader and its encoded source remain caller-owned. Runtime authority is
 * issued only after both table indexes and their source evidence have reopened.
 * This is deliberately an origin-trusted same-app manifest boundary: incoming
 * data is structurally untrusted and strictly canonicalized, but its app origin
 * is assumed. Codec, timeline, container diagnostics, and declared `mdat` ranges
 * are not reparsed here. `stsz`, `stsc`, and chunk-table evidence are rebound to
 * the source now; their remaining authenticated pages are consumed lazily by the
 * future cursor. An external/untrusted manifest needs separate authentication.
 */
export async function openM4aAacRuntime(
  reader: IsoBmffBoxReader,
  manifestValue: unknown,
  signal: AbortSignal,
): Promise<M4aAacRuntime> {
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('M4A AAC runtime requires an AbortSignal');
  }
  throwIfRuntimeAborted(signal);
  if (!(reader instanceof IsoBmffBoxReader)) {
    throw new TypeError('M4A AAC runtime requires an IsoBmffBoxReader');
  }

  let manifest: Readonly<M4aAacLcManifest>;
  try {
    manifest = validateM4aAacLcManifest(manifestValue);
  } catch (error) {
    // A hostile synchronous inspection can reenter and abort. Preserve the
    // operation's exact cancellation authority instead of its secondary error.
    throwIfRuntimeAborted(signal);
    throw error;
  }
  throwIfRuntimeAborted(signal);
  const expectedSource: Readonly<M4aIndexSourceBinding> = Object.freeze({
    sourceSize: manifest.sourceSize,
    sourceIdentity: manifest.sourceIdentity,
  });
  if (
    reader.sourceSize !== expectedSource.sourceSize ||
    reader.sourceIdentity !== expectedSource.sourceIdentity
  ) {
    throw runtimeError('M4A AAC manifest source binding does not match its runtime reader');
  }
  reader.assertReadable(signal);

  const sampleSizes = await rehydrateM4aSampleSizeIndex(
    reader,
    manifest.sampleSizes,
    expectedSource,
    signal,
  );
  const chunks = await rehydrateM4aChunkIndex(
    reader,
    manifest.chunks,
    sampleSizes,
    expectedSource,
    signal,
  );
  assertFinalRuntimeGeometry(manifest, sampleSizes, chunks);
  reader.assertReadable(signal);

  const info = createRuntimeInfo(manifest);
  const runtime: M4aAacRuntime = Object.freeze({
    info,
    createGenerationStartPlan(this: M4aAacRuntime, mediaFrame: number) {
      return createM4aAacGenerationStartPlan(this, mediaFrame);
    },
    requireGenerationStartPlan(this: M4aAacRuntime, value: unknown) {
      return requireM4aAacGenerationStartPlan(this, value);
    },
    openAccessUnitReader(this: M4aAacRuntime, plan: unknown, signal: AbortSignal) {
      return openM4aAacRuntimeAccessUnitReader(this, plan, signal);
    },
    close(this: M4aAacRuntime) {
      closeM4aAacRuntime(this);
    },
  });
  runtimeAuthorities.set(runtime, {
    reader,
    sampleSizes,
    chunks,
    info,
    closedError: new M4aAacRuntimeClosedError(),
    closed: false,
    cursorIssued: false,
    cursorOpenFailure: undefined,
    hasCursorOpenFailure: false,
    openingCursor: null,
    activeCursor: null,
  });
  return runtime;
}

/** Build the exact one-AU product-preroll plan for a live issued runtime. */
export function createM4aAacGenerationStartPlan(
  runtimeValue: unknown,
  mediaFrameValue: unknown,
): Readonly<M4aAacGenerationStartPlan> {
  const authority = requireRuntimeAuthority(runtimeValue);
  const plan = createM4aAacStartPlan(authority.info.timeline, mediaFrameValue);
  startPlanAuthorities.set(plan, {
    runtime: runtimeValue as M4aAacRuntime,
    plan,
  });
  return plan;
}

/** Reject clones, forged records, foreign-runtime plans, and plans from closed runtimes. */
export function requireM4aAacGenerationStartPlan(
  runtimeValue: unknown,
  planValue: unknown,
): Readonly<M4aAacGenerationStartPlan> {
  requireRuntimeAuthority(runtimeValue);
  const authority =
    planValue !== null && (typeof planValue === 'object' || typeof planValue === 'function')
      ? startPlanAuthorities.get(planValue)
      : undefined;
  if (authority === undefined) {
    throw new TypeError('M4A AAC generation start plan was not issued by this module');
  }
  if (authority.runtime !== runtimeValue) {
    throw new TypeError('M4A AAC generation start plan belongs to a different runtime');
  }
  return authority.plan;
}

function closeRawAccessUnitReader(cursor: M4aRawAacAccessUnitReader | null): void {
  if (cursor === null) return;
  try {
    closeM4aRawAacAccessUnitReader(cursor);
  } catch {
    // Cursor authority is module-issued and close is specified as idempotent.
    // A secondary close failure must never replace cancellation or runtime close.
  }
}

async function openM4aAacRuntimeAccessUnitReader(
  runtimeValue: unknown,
  planValue: unknown,
  signal: AbortSignal,
): Promise<M4aRawAacAccessUnitReader> {
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('M4A AAC runtime access-unit reader requires an AbortSignal');
  }
  throwIfRuntimeAborted(signal);
  const authority = requireRuntimeAuthority(runtimeValue);
  const plan = requireM4aAacGenerationStartPlan(runtimeValue, planValue);
  throwIfRuntimeAborted(signal);

  if (authority.closed) throw authority.closedError;
  if (authority.openingCursor !== null) {
    throw runtimeError('Concurrent or reentrant M4A AAC runtime cursor opens are not supported');
  }
  if (authority.cursorIssued) {
    throw runtimeError('M4A AAC runtime has already issued its access-unit reader');
  }
  if (authority.hasCursorOpenFailure) throw authority.cursorOpenFailure;
  const reader = authority.reader;
  const sampleSizes = authority.sampleSizes;
  const chunks = authority.chunks;
  if (reader === null || sampleSizes === null || chunks === null) {
    throw authority.closedError;
  }

  const controller = new AbortController();
  const operationSignal = controller.signal;
  if (!Reflect.preventExtensions(operationSignal)) {
    throw runtimeError('M4A AAC runtime could not seal its cursor-open cancellation signal');
  }
  const forwardCallerAbort = (): void => {
    controller.abort(readAbortReason(signal));
  };
  let listenerInstalled = false;
  const detachCallerAbort = (): void => {
    if (!listenerInstalled) return;
    listenerInstalled = false;
    try {
      Reflect.apply(trustedEventTargetRemove, signal, ['abort', forwardCallerAbort]);
    } catch {
      // The exact native AbortSignal was already validated. Detachment is
      // best-effort and must never break cursor publication or runtime cleanup.
    }
  };
  const operation: RuntimeCursorOpenOperation = Object.freeze({
    controller,
    detachCallerAbort,
  });
  authority.openingCursor = operation;

  let candidate: M4aRawAacAccessUnitReader | null = null;
  try {
    Reflect.apply(trustedEventTargetAdd, signal, ['abort', forwardCallerAbort, { once: true }]);
    listenerInstalled = true;
    // Cover an abort that happened after the initial check but before listener install.
    if (isAborted(signal)) forwardCallerAbort();
    candidate = await openSourceBoundM4aRawAacAccessUnitReader(
      reader,
      sampleSizes,
      chunks,
      plan.decodeStartAccessUnitOrdinal,
      operationSignal,
    );
    throwIfRuntimeAborted(operationSignal);
    if (authority.closed || authority.openingCursor !== operation) {
      throw authority.closedError;
    }

    authority.activeCursor = candidate;
    authority.cursorIssued = true;
    return candidate;
  } catch (error) {
    closeRawAccessUnitReader(candidate);
    if (isAborted(operationSignal)) throwIfRuntimeAborted(operationSignal);
    if (authority.closed) throw authority.closedError;
    if (!(error instanceof EncodedSourceBusyError)) {
      authority.cursorOpenFailure = error;
      authority.hasCursorOpenFailure = true;
    }
    throw error;
  } finally {
    detachCallerAbort();
    if (authority.openingCursor === operation) authority.openingCursor = null;
  }
}

/** Idempotently revoke one issued runtime without touching its borrowed source. */
export function closeM4aAacRuntime(runtimeValue: unknown): void {
  const isObject =
    runtimeValue !== null &&
    (typeof runtimeValue === 'object' || typeof runtimeValue === 'function');
  if (isObject && closedRuntimes.has(runtimeValue)) return;
  const authority = requireRuntimeAuthority(runtimeValue);
  if (authority.closed) return;
  authority.closed = true;
  if (authority.openingCursor !== null) {
    authority.openingCursor.controller.abort(authority.closedError);
    authority.openingCursor.detachCallerAbort();
  }
  closeRawAccessUnitReader(authority.activeCursor);
  authority.activeCursor = null;
  authority.reader = null;
  authority.sampleSizes = null;
  authority.chunks = null;
  authority.cursorOpenFailure = undefined;
  authority.hasCursorOpenFailure = false;
  runtimeAuthorities.delete(runtimeValue as object);
  closedRuntimes.add(runtimeValue as object);
}
