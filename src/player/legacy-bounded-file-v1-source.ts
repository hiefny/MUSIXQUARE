import { AacWebCodecsUnavailableError } from './aac/webcodecs-canary.ts';
import {
  FILE_PLAYBACK_MP3_M4A_V1_BOUNDED_ROUTE_POLICY,
  snapshotFilePlaybackBoundedRoutePolicy,
  type FilePlaybackBoundedRoutePolicy,
} from './file-playback-bounded-route-policy.ts';
import {
  canonicalizeFilePlaybackR2RecordDeliveryScope,
  canonicalizeFilePlaybackR2RecordDescriptorRef,
  sameFilePlaybackR2RecordDeliveryScope,
  type FilePlaybackR2RecordDeliveryScope,
  type FilePlaybackR2RecordDescriptorRef,
} from './file-playback-r2-record-descriptor.ts';
import {
  createEncodedFilePlaybackSource,
  UnsupportedFlacContainerError,
  UnsupportedOrdinaryEncodedSourceError,
  type BlobFilePlaybackSourceResult,
  type CreateEncodedFilePlaybackSourceOptions,
} from './file-playback-source-factory.ts';
import type { FilePlaybackCutoverSource } from './file-playback-source.ts';
import type { LegacyBoundedFileOpenedSource } from './legacy-bounded-file-port-contract.ts';
import { M4aRawAacWebCodecsUnavailableError } from './m4a/webcodecs-canary.ts';
import {
  BlobEncodedAudioSource,
  getBlobObjectIdentity,
  type BlobEncodedAudioSourceOptions,
} from './sources/blob-encoded-audio-source.ts';
import {
  EncodedSourceIntegrityError,
  isEncodedAudioSourceIdentity,
  throwIfAborted,
  type EncodedAudioSource,
} from './sources/encoded-audio-source.ts';

type LegacyBoundedFileV1EncodedSourceOpener = (signal: AbortSignal) => Promise<EncodedAudioSource>;

/**
 * One immutable byte-source incarnation. The opener must return a fresh
 * source on every invocation and transfers that source to the adapter.
 */
export interface LegacyBoundedFileV1EncodedSourceBinding {
  readonly sourceIdentity: string;
  readonly open: LegacyBoundedFileV1EncodedSourceOpener;
}

interface LegacyBoundedFileV1R2DeliveryProvider {
  open(input: {
    readonly scope: Readonly<FilePlaybackR2RecordDeliveryScope>;
    readonly descriptor: Readonly<FilePlaybackR2RecordDescriptorRef>;
    readonly signal: AbortSignal;
  }): Promise<EncodedAudioSource>;
}

interface LegacyBoundedFileV1BlobBindingOptions {
  readonly blob: Blob;
  readonly sourceIdentity?: string;
  readonly metadata?: BlobEncodedAudioSourceOptions['metadata'];
}

interface LegacyBoundedFileV1R2BindingOptions {
  readonly provider: LegacyBoundedFileV1R2DeliveryProvider;
  readonly scope: Readonly<FilePlaybackR2RecordDeliveryScope>;
  readonly descriptor: Readonly<FilePlaybackR2RecordDescriptorRef>;
}

type LegacyBoundedFileV1PlaybackSourceFactory = (
  options: CreateEncodedFilePlaybackSourceOptions,
) => Promise<BlobFilePlaybackSourceResult>;

type LegacyBoundedFileV1FactoryOptions = Omit<
  CreateEncodedFilePlaybackSourceOptions,
  'encodedSource' | 'signal' | 'boundedRoutePolicy'
>;

export type LegacyBoundedFileV1SourceAdapterOptions = Readonly<
  LegacyBoundedFileV1FactoryOptions & {
    readonly binding: Readonly<LegacyBoundedFileV1EncodedSourceBinding>;
    readonly destination: AudioNode;
    /**
     * Only policies that keep raw ADTS AAC on the stable V1 path are admitted.
     * The beta MP3/M4A cohort is the default.
     */
    readonly boundedRoutePolicy?: Readonly<FilePlaybackBoundedRoutePolicy>;
    /** Deterministic construction seam; production uses the shared factory. */
    readonly createPlaybackSource?: LegacyBoundedFileV1PlaybackSourceFactory;
  }
>;

type LegacyBoundedFileV1FallbackReason =
  | 'unsupported-source'
  | 'capability-unavailable'
  | 'audio-context-closed'
  | 'policy-unsupported';

export type LegacyBoundedFileV1SourceOpenOutcome =
  | Readonly<{
      readonly status: 'opened';
      readonly sourceIdentity: string;
      /**
       * The port's successful `prepare().ready` snapshot is the first
       * authoritative duration evidence; the adapter does not invent one.
       */
      readonly opened: Readonly<LegacyBoundedFileOpenedSource>;
    }>
  | Readonly<{
      readonly status: 'fallback';
      readonly reason: LegacyBoundedFileV1FallbackReason;
    }>;

export interface LegacyBoundedFileV1SourceAdapter {
  open(signal: AbortSignal): Promise<LegacyBoundedFileV1SourceOpenOutcome>;
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function assertSourceIdentity(value: unknown): asserts value is string {
  if (!isEncodedAudioSourceIdentity(value) || (value as string).trim() !== value) {
    throw new TypeError('Legacy bounded source identity is invalid');
  }
}

function assertAbortSignal(signal: unknown): asserts signal is AbortSignal {
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('Legacy bounded source opener requires an AbortSignal');
  }
}

function canonicalSupportedPolicy(value: unknown): Readonly<FilePlaybackBoundedRoutePolicy> | null {
  const policy = snapshotFilePlaybackBoundedRoutePolicy(
    value ?? FILE_PLAYBACK_MP3_M4A_V1_BOUNDED_ROUTE_POLICY,
  );
  if (policy.mode === 'universal-v1') return null;
  if (policy.mode === 'format-gated-v1' && policy.rawAdtsAac !== 'current') {
    return null;
  }
  return policy;
}

function destinationContext(destination: AudioNode): AudioContext {
  if (destination === null || typeof destination !== 'object' || Array.isArray(destination)) {
    throw new TypeError('Legacy bounded audio destination is invalid');
  }
  let context: BaseAudioContext;
  try {
    context = destination.context;
  } catch (cause) {
    throw new TypeError('Legacy bounded audio destination context is unreadable', {
      cause,
    });
  }
  if (context === null || typeof context !== 'object') {
    throw new TypeError('Legacy bounded audio destination has no context');
  }
  return context as AudioContext;
}

function isClosedAudioContext(audioContext: AudioContext): boolean {
  let state: unknown;
  try {
    state = audioContext.state;
  } catch (cause) {
    throw new TypeError('Legacy bounded AudioContext state is unreadable', { cause });
  }
  if (typeof state !== 'string') {
    throw new TypeError('Legacy bounded AudioContext state is invalid');
  }
  return state === 'closed';
}

function isCompatibilityFallback(error: unknown): LegacyBoundedFileV1FallbackReason | null {
  if (
    error instanceof UnsupportedOrdinaryEncodedSourceError ||
    error instanceof UnsupportedFlacContainerError
  ) {
    return 'unsupported-source';
  }
  if (
    error instanceof AacWebCodecsUnavailableError ||
    error instanceof M4aRawAacWebCodecsUnavailableError
  ) {
    return 'capability-unavailable';
  }
  return null;
}

function fallback(reason: LegacyBoundedFileV1FallbackReason): LegacyBoundedFileV1SourceOpenOutcome {
  return Object.freeze({ status: 'fallback' as const, reason });
}

const CUTOVER_SOURCE_METHODS = Object.freeze([
  'primeForCutover',
  'armForCutover',
  'pauseRevisioned',
  'seekRevisioned',
] as const satisfies readonly (keyof FilePlaybackCutoverSource)[]);

function asCutoverSource(value: unknown): FilePlaybackCutoverSource {
  try {
    if (value === null || typeof value !== 'object') {
      throw new TypeError('Legacy bounded factory returned an invalid source');
    }
    for (const method of CUTOVER_SOURCE_METHODS) {
      if (typeof (value as Partial<FilePlaybackCutoverSource>)[method] !== 'function') {
        throw new TypeError(`Legacy bounded factory source is missing ${String(method)}`);
      }
    }
    return value as FilePlaybackCutoverSource;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError('Legacy bounded factory source could not be inspected', {
      cause: error,
    });
  }
}

async function closeEncodedSourceQuietly(source: EncodedAudioSource): Promise<void> {
  try {
    await source.close();
  } catch {
    // Cleanup must not replace a typed admission/auth/integrity failure.
  }
}

async function destroyPlaybackResultQuietly(result: BlobFilePlaybackSourceResult): Promise<void> {
  try {
    result.releaseConstructionLease();
  } catch {
    // A construction lease cannot make an inadmissible source authoritative.
  }
  try {
    await result.source.destroy();
  } catch {
    // Preserve the exact admission failure.
  }
}

function snapshotBinding(
  value: Readonly<LegacyBoundedFileV1EncodedSourceBinding>,
): Readonly<LegacyBoundedFileV1EncodedSourceBinding> {
  const sourceIdentity = value.sourceIdentity;
  const open = value.open;
  assertSourceIdentity(sourceIdentity);
  if (typeof open !== 'function') {
    throw new TypeError('Legacy bounded encoded source opener is invalid');
  }
  return frozen({ sourceIdentity, open });
}

/**
 * Produce a fresh local Blob source for each bounded preparation attempt.
 * No decoded AudioBuffer is created or retained by this adapter.
 */
export function createLegacyBoundedFileV1BlobBinding(
  options: LegacyBoundedFileV1BlobBindingOptions,
): Readonly<LegacyBoundedFileV1EncodedSourceBinding> {
  const blob = options.blob;
  if (!(blob instanceof Blob)) {
    throw new TypeError('Legacy bounded Blob binding requires a Blob');
  }
  const sourceIdentity = options.sourceIdentity ?? getBlobObjectIdentity(blob);
  const metadata = options.metadata;
  assertSourceIdentity(sourceIdentity);
  return frozen({
    sourceIdentity,
    open: async (signal: AbortSignal) => {
      assertAbortSignal(signal);
      throwIfAborted(signal);
      const source = new BlobEncodedAudioSource(blob, {
        identity: sourceIdentity,
        metadata,
      });
      try {
        throwIfAborted(signal);
        return source;
      } catch (error) {
        await closeEncodedSourceQuietly(source);
        throw error;
      }
    },
  });
}

/**
 * Bind an injected delivery provider to one exact body-free descriptor. The
 * provider remains the sole owner of network/authentication concerns.
 */
export function createLegacyBoundedFileV1R2Binding(
  options: LegacyBoundedFileV1R2BindingOptions,
): Readonly<LegacyBoundedFileV1EncodedSourceBinding> {
  const provider = options.provider;
  const providerOpen = provider?.open;
  if (typeof providerOpen !== 'function') {
    throw new TypeError('Legacy bounded R2 delivery provider is invalid');
  }
  const scope = canonicalizeFilePlaybackR2RecordDeliveryScope(options.scope);
  const descriptor = canonicalizeFilePlaybackR2RecordDescriptorRef(options.descriptor);
  if (!sameFilePlaybackR2RecordDeliveryScope(scope, descriptor.scope)) {
    throw new TypeError('Legacy bounded R2 descriptor scope does not match its binding');
  }
  return frozen({
    sourceIdentity: scope.sourceIdentity,
    open: (signal: AbortSignal) => {
      assertAbortSignal(signal);
      throwIfAborted(signal);
      return Reflect.apply(providerOpen, provider, [
        frozen({ scope, descriptor, signal }),
      ]) as Promise<EncodedAudioSource>;
    },
  });
}

/**
 * Construct the delivery-to-renderer adapter without room, wire, UI, or
 * connection authority. Unsupported/capability cases return a typed fallback
 * before the LegacyBoundedFilePort owns a renderer; all other failures retain
 * their original error identity.
 */
export function createLegacyBoundedFileV1SourceAdapter(
  options: LegacyBoundedFileV1SourceAdapterOptions,
): Readonly<LegacyBoundedFileV1SourceAdapter> {
  const binding = snapshotBinding(options.binding);
  const destination = options.destination;
  const audioContext = options.audioContext;
  if (destinationContext(destination) !== audioContext) {
    throw new TypeError('Legacy bounded destination and AudioContext do not match');
  }
  const policy = canonicalSupportedPolicy(options.boundedRoutePolicy);
  const createPlaybackSource = options.createPlaybackSource ?? createEncodedFilePlaybackSource;
  if (typeof createPlaybackSource !== 'function') {
    throw new TypeError('Legacy bounded playback source factory is invalid');
  }

  const factoryOptions: LegacyBoundedFileV1FactoryOptions = {
    queueItemId: options.queueItemId,
    audioContext,
    nowRoomTimeMs: options.nowRoomTimeMs,
    roomTimeMsToContextTime: options.roomTimeMsToContextTime,
    localPerformanceMsToContextTime: options.localPerformanceMsToContextTime,
    flacRuntime: options.flacRuntime,
    linearPcmRuntime: options.linearPcmRuntime,
    mp3Runtime: options.mp3Runtime,
    aacRuntime: options.aacRuntime,
    aacCapabilityProbe: options.aacCapabilityProbe,
    m4aRuntime: options.m4aRuntime,
    codecTimelineHostArtifactBinding: options.codecTimelineHostArtifactBinding,
    backendFactories: options.backendFactories,
  };

  return frozen({
    async open(signal: AbortSignal): Promise<LegacyBoundedFileV1SourceOpenOutcome> {
      assertAbortSignal(signal);
      throwIfAborted(signal);
      if (policy === null) {
        return fallback('policy-unsupported');
      }
      if (isClosedAudioContext(audioContext)) {
        return fallback('audio-context-closed');
      }

      const encodedSource = await binding.open(signal);
      let result: BlobFilePlaybackSourceResult;
      try {
        result = await createPlaybackSource({
          ...factoryOptions,
          encodedSource,
          signal,
          boundedRoutePolicy: policy,
        });
      } catch (error) {
        await closeEncodedSourceQuietly(encodedSource);
        const fallbackReason = isCompatibilityFallback(error);
        if (fallbackReason !== null) {
          return fallback(fallbackReason);
        }
        throw error;
      }

      try {
        throwIfAborted(signal);
      } catch (error) {
        await destroyPlaybackResultQuietly(result);
        throw error;
      }
      if (result.backend !== 'bounded-stream') {
        await destroyPlaybackResultQuietly(result);
        return fallback('unsupported-source');
      }
      if (result.sourceIdentity !== binding.sourceIdentity) {
        await destroyPlaybackResultQuietly(result);
        throw new EncodedSourceIntegrityError(
          'Legacy bounded playback source identity does not match its exact binding',
        );
      }
      let audioContextClosed: boolean;
      try {
        audioContextClosed = isClosedAudioContext(audioContext);
      } catch (error) {
        await destroyPlaybackResultQuietly(result);
        throw error;
      }
      if (audioContextClosed) {
        await destroyPlaybackResultQuietly(result);
        return fallback('audio-context-closed');
      }
      let source: FilePlaybackCutoverSource;
      try {
        source = asCutoverSource(result.source);
      } catch (error) {
        await destroyPlaybackResultQuietly(result);
        throw error;
      }
      return Object.freeze({
        status: 'opened' as const,
        sourceIdentity: result.sourceIdentity,
        opened: frozen({
          source,
          destination,
        }),
      });
    },
  });
}
