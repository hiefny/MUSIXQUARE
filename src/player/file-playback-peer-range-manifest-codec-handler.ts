import type { QueueItemId } from '../types/index.ts';
import {
  reconstructAdtsManifestStructure,
  type AdtsManifestStructuralReconstruction,
} from './aac/adts-manifest-structural-reconstruction.ts';
import {
  createAdtsDecoderTimelineEvidenceFromManifestReconstruction,
  type AdtsDecoderTimelineEvidence,
} from './aac/decoder-timeline-evidence.ts';
import { AdtsIncrementalFrameReader } from './aac/incremental-frame-reader.ts';
import {
  probeAacWebCodecsAdtsFrameInWorker,
  type AacWorkerCapabilityProbeRuntime,
} from './aac/worker-capability-probe.ts';
import {
  createDefaultAacStreamingWorker,
  StreamingAacPlaybackSource,
  type StreamingAacPlaybackSourceOptions,
} from './backends/streaming-aac-playback-source.ts';
import {
  StreamingMp3PlaybackSource,
  type StreamingMp3PlaybackSourceOptions,
} from './backends/streaming-mp3-playback-source.ts';
import type {
  CodecTimelineManifest,
  CodecTimelineManifestCodec,
} from './manifests/codec-timeline-manifest.ts';
import { createMp3DecoderTimelineEvidenceFromManifestReconstruction } from './mp3/decoder-helpers.ts';
import type { Mp3DecoderTimelineEvidence } from './mp3/decoder-timeline-evidence.ts';
import {
  reconstructMp3ManifestStructure,
  type Mp3ManifestStructuralReconstruction,
} from './mp3/manifest-structural-reconstruction.ts';
import {
  type EncodedAudioSource,
  EncodedSourceIntegrityError,
} from './sources/encoded-audio-source.ts';
import type { BoundedStreamingCodecRuntime } from './streaming/bounded-codec-runtime.ts';

export const MANIFEST_CODEC_HANDLER_RUNTIME_OPTION_KEYS = Object.freeze([
  'aacRuntime',
  'mp3Runtime',
  'runtimeForTests',
] as const);

const CODEC_RUNTIME_KEYS = Object.freeze([
  'loadWorklet',
  'createWorker',
  'createWorkletNode',
  'createMessageChannel',
] as const satisfies readonly (keyof BoundedStreamingCodecRuntime)[]);
const TEST_RUNTIME_KEYS = Object.freeze([
  'aacCapabilityProbe',
  'createStreamingAacSource',
  'createStreamingMp3Source',
] as const);

type AnyMethod = (...args: never[]) => unknown;
type ManifestFor<Codec extends CodecTimelineManifestCodec> = Extract<
  CodecTimelineManifest,
  { codec: Codec }
>;

type AacCapabilityProbe = (
  frame: Uint8Array,
  signal: AbortSignal,
  runtime: AacWorkerCapabilityProbeRuntime,
) => Promise<void>;
type CreateStreamingAacSource = (
  options: StreamingAacPlaybackSourceOptions,
) => StreamingAacPlaybackSource;
type CreateStreamingMp3Source = (
  options: StreamingMp3PlaybackSourceOptions,
) => StreamingMp3PlaybackSource;

/** Browser/native seams used only by focused manifest-handler boundary tests. */
export interface ManifestCodecHandlerRuntimeForTests {
  readonly aacCapabilityProbe?: AacCapabilityProbe;
  readonly createStreamingAacSource?: CreateStreamingAacSource;
  readonly createStreamingMp3Source?: CreateStreamingMp3Source;
}

export interface ManifestCodecHandlerRuntimeOptions {
  /** The same snapshotted worker authority is used by the ADTS canary and playback. */
  readonly aacRuntime?: Partial<BoundedStreamingCodecRuntime>;
  readonly mp3Runtime?: Partial<BoundedStreamingCodecRuntime>;
  readonly runtimeForTests?: ManifestCodecHandlerRuntimeForTests;
}

export type ManifestCodecDecoderSource = StreamingAacPlaybackSource | StreamingMp3PlaybackSource;

export interface ManifestCodecSourceConstructionContext {
  readonly queueItemId: QueueItemId;
  readonly encodedSource: EncodedAudioSource;
  readonly audioContext: AudioContext;
  readonly nowRoomTimeMs: () => number;
  readonly roomTimeMsToContextTime: (roomTimeMs: number) => number;
  readonly localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;
}

/** Codec-private reconstruction/evidence captured behind one construction closure. */
export interface PreparedManifestCodecHandler {
  readonly codec: CodecTimelineManifestCodec;
  readonly constructSource: (
    context: Readonly<ManifestCodecSourceConstructionContext>,
  ) => ManifestCodecDecoderSource;
}

/** Runtime-bound handler selected before the bridge acquires a source lease. */
export interface BoundManifestCodecHandler {
  readonly codec: CodecTimelineManifestCodec;
  readonly prepare: (
    source: EncodedAudioSource,
    signal: AbortSignal,
  ) => Promise<Readonly<PreparedManifestCodecHandler>>;
}

interface RuntimeOptionSnapshot {
  readonly aacRuntime: unknown;
  readonly mp3Runtime: unknown;
  readonly runtimeForTests: unknown;
}

interface TestRuntimeSnapshot {
  readonly aacCapabilityProbe: AacCapabilityProbe;
  readonly createStreamingAacSource: CreateStreamingAacSource;
  readonly createStreamingMp3Source: CreateStreamingMp3Source;
}

interface AdtsHandlerRuntime {
  readonly codecRuntime: Readonly<Partial<BoundedStreamingCodecRuntime>>;
  readonly testRuntime: Readonly<TestRuntimeSnapshot>;
}

interface Mp3HandlerRuntime {
  readonly codecRuntime: Readonly<Partial<BoundedStreamingCodecRuntime>>;
  readonly testRuntime: Readonly<TestRuntimeSnapshot>;
}

interface HandlerPrepareContext<Codec extends CodecTimelineManifestCodec, Runtime> {
  readonly manifest: Readonly<ManifestFor<Codec>>;
  readonly source: EncodedAudioSource;
  readonly signal: AbortSignal;
  readonly runtime: Readonly<Runtime>;
}

interface HandlerConstructContext<Runtime, Evidence> {
  readonly source: Readonly<ManifestCodecSourceConstructionContext>;
  readonly runtime: Readonly<Runtime>;
  readonly evidence: Readonly<Evidence>;
}

/**
 * One closed, compile-time codec definition. Runtime snapshotting, structural
 * reconstruction, admission canaries, decoder evidence, and source creation
 * cannot be registered or replaced independently at runtime.
 */
interface ManifestCodecHandler<
  Codec extends CodecTimelineManifestCodec,
  Runtime,
  Evidence,
  Source extends ManifestCodecDecoderSource,
> {
  readonly codec: Codec;
  readonly snapshotRuntime: (options: Readonly<RuntimeOptionSnapshot>) => Readonly<Runtime>;
  readonly prepare: (
    context: Readonly<HandlerPrepareContext<Codec, Runtime>>,
  ) => Promise<Readonly<Evidence>>;
  readonly construct: (context: Readonly<HandlerConstructContext<Runtime, Evidence>>) => Source;
}

interface StaticManifestCodecHandler<Codec extends CodecTimelineManifestCodec> {
  readonly codec: Codec;
  readonly bind: (
    manifest: Readonly<ManifestFor<Codec>>,
    options: Readonly<RuntimeOptionSnapshot>,
  ) => Readonly<BoundManifestCodecHandler>;
}

function freezeCanonical<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), value)) as Readonly<T>;
}

function snapshotRuntimeOptions(value: unknown): Readonly<RuntimeOptionSnapshot> {
  try {
    if (value === null || typeof value !== 'object') {
      throw new TypeError('Manifest codec runtime options are invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of MANIFEST_CODEC_HANDLER_RUNTIME_OPTION_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`Manifest codec runtime option ${key} must be data`);
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot) as Readonly<RuntimeOptionSnapshot>;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('Manifest codec runtime')) {
      throw error;
    }
    throw new TypeError('Manifest codec runtime options could not be snapshotted', {
      cause: error,
    });
  }
}

function snapshotOptionalMethods(
  value: unknown,
  keys: readonly string[],
  label: string,
): Readonly<Record<string, AnyMethod>> {
  if (value === undefined) return Object.freeze(Object.create(null));
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${label} must be an exact record`);
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must be an exact record`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    const allowed = new Set<string>(keys);
    if (ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
      throw new TypeError(`${label} has unknown methods`);
    }
    const result = Object.create(null) as Record<string, AnyMethod>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      if (
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        typeof descriptor.value !== 'function'
      ) {
        throw new TypeError(`${label} ${key} must be an enumerable data method`);
      }
      const method = descriptor.value as AnyMethod;
      const receiver = value;
      result[key] = ((...args: never[]) => Reflect.apply(method, receiver, args)) as AnyMethod;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(label)) throw error;
    throw new TypeError(`${label} could not be snapshotted`, { cause: error });
  }
}

function snapshotCodecRuntime(
  value: unknown,
  codec: CodecTimelineManifestCodec,
  defaultWorker?: () => Worker,
): Readonly<Partial<BoundedStreamingCodecRuntime>> {
  const methods = snapshotOptionalMethods(value, CODEC_RUNTIME_KEYS, `${codec} playback runtime`);
  const runtime = Object.create(null) as Partial<BoundedStreamingCodecRuntime>;
  for (const key of CODEC_RUNTIME_KEYS) {
    const method = methods[key] as BoundedStreamingCodecRuntime[typeof key] | undefined;
    if (method) Object.defineProperty(runtime, key, { enumerable: true, value: method });
  }
  if (runtime.createWorker === undefined && defaultWorker) {
    Object.defineProperty(runtime, 'createWorker', {
      enumerable: true,
      value: defaultWorker,
    });
  }
  return Object.freeze(runtime);
}

function snapshotTestRuntime(value: unknown): Readonly<TestRuntimeSnapshot> {
  const methods = snapshotOptionalMethods(
    value,
    TEST_RUNTIME_KEYS,
    'manifest decoder test runtime',
  );
  return Object.freeze({
    aacCapabilityProbe:
      (methods.aacCapabilityProbe as AacCapabilityProbe | undefined) ??
      probeAacWebCodecsAdtsFrameInWorker,
    createStreamingAacSource:
      (methods.createStreamingAacSource as CreateStreamingAacSource | undefined) ??
      ((options: StreamingAacPlaybackSourceOptions) => new StreamingAacPlaybackSource(options)),
    createStreamingMp3Source:
      (methods.createStreamingMp3Source as CreateStreamingMp3Source | undefined) ??
      ((options: StreamingMp3PlaybackSourceOptions) => new StreamingMp3PlaybackSource(options)),
  });
}

function defineManifestCodecHandler<
  const Codec extends CodecTimelineManifestCodec,
  Runtime,
  Evidence,
  Source extends ManifestCodecDecoderSource,
>(
  handler: Readonly<ManifestCodecHandler<Codec, Runtime, Evidence, Source>>,
): Readonly<StaticManifestCodecHandler<Codec>> {
  return Object.freeze({
    codec: handler.codec,
    bind(
      manifest: Readonly<ManifestFor<Codec>>,
      options: Readonly<RuntimeOptionSnapshot>,
    ): Readonly<BoundManifestCodecHandler> {
      const runtime = handler.snapshotRuntime(options);
      return freezeCanonical({
        codec: handler.codec,
        async prepare(
          source: EncodedAudioSource,
          signal: AbortSignal,
        ): Promise<Readonly<PreparedManifestCodecHandler>> {
          const evidence = await handler.prepare({ manifest, source, signal, runtime });
          return freezeCanonical({
            codec: handler.codec,
            constructSource: (construction: Readonly<ManifestCodecSourceConstructionContext>) =>
              handler.construct({ source: construction, runtime, evidence }),
          });
        },
      });
    },
  });
}

const ADTS_HANDLER = defineManifestCodecHandler({
  codec: 'adts-aac-lc',
  snapshotRuntime: (options): Readonly<AdtsHandlerRuntime> =>
    Object.freeze({
      codecRuntime: snapshotCodecRuntime(
        options.aacRuntime,
        'adts-aac-lc',
        createDefaultAacStreamingWorker,
      ),
      testRuntime: snapshotTestRuntime(options.runtimeForTests),
    }),
  async prepare({ manifest, source, signal, runtime }): Promise<AdtsDecoderTimelineEvidence> {
    const reconstruction: Readonly<AdtsManifestStructuralReconstruction> =
      await reconstructAdtsManifestStructure({ manifest, signal, source });
    const evidence = createAdtsDecoderTimelineEvidenceFromManifestReconstruction(reconstruction);

    const firstFrameLength = reconstruction.endpointChecks.firstFrameByteLength;
    const reader = new AdtsIncrementalFrameReader({
      source,
      audioStartByte: manifest.audioStartByte,
      start: { byteOffset: manifest.audioStartByte, frameOrdinal: 0 },
      expectedConfig: reconstruction.coreConfiguration,
      pageBytes: firstFrameLength,
    });
    const firstFrame = await reader.readNext(signal);
    if (
      !firstFrame ||
      firstFrame.bytes.byteLength !== firstFrameLength ||
      firstFrame.descriptor.frameOrdinal !== 0 ||
      firstFrame.descriptor.byteOffset !== manifest.audioStartByte ||
      firstFrame.descriptor.byteEndOffset !== manifest.audioStartByte + firstFrameLength ||
      firstFrame.descriptor.header.frameLengthBytes !== firstFrameLength
    ) {
      throw new EncodedSourceIntegrityError(
        'ADTS manifest canary reread contradicts its reconstructed first endpoint',
      );
    }
    try {
      const probeTask = runtime.testRuntime.aacCapabilityProbe(
        firstFrame.bytes,
        signal,
        runtime.codecRuntime as AacWorkerCapabilityProbeRuntime,
      );
      if (!(probeTask instanceof Promise)) {
        throw new TypeError('AAC manifest capability probe must return a native Promise');
      }
      await probeTask;
    } finally {
      try {
        firstFrame.bytes.fill(0);
      } catch {
        // The one-frame canary copy is bounded and becomes unreachable here.
      }
    }
    return evidence;
  },
  construct: ({ source, runtime, evidence }) =>
    runtime.testRuntime.createStreamingAacSource({
      queueItemId: source.queueItemId,
      encodedSource: source.encodedSource,
      audioContext: source.audioContext,
      nowRoomTimeMs: source.nowRoomTimeMs,
      roomTimeMsToContextTime: source.roomTimeMsToContextTime,
      localPerformanceMsToContextTime: source.localPerformanceMsToContextTime,
      runtime: runtime.codecRuntime,
      timelineEvidence: evidence,
      backendId: 'webcodecs',
    }),
});

const MP3_HANDLER = defineManifestCodecHandler({
  codec: 'mp3-no-frame-count',
  snapshotRuntime: (options): Readonly<Mp3HandlerRuntime> =>
    Object.freeze({
      codecRuntime: snapshotCodecRuntime(options.mp3Runtime, 'mp3-no-frame-count'),
      testRuntime: snapshotTestRuntime(options.runtimeForTests),
    }),
  async prepare({ manifest, source, signal }): Promise<Mp3DecoderTimelineEvidence> {
    const reconstruction: Readonly<Mp3ManifestStructuralReconstruction> =
      await reconstructMp3ManifestStructure({ manifest, signal, source });
    return createMp3DecoderTimelineEvidenceFromManifestReconstruction(reconstruction);
  },
  construct: ({ source, runtime, evidence }) =>
    runtime.testRuntime.createStreamingMp3Source({
      queueItemId: source.queueItemId,
      encodedSource: source.encodedSource,
      audioContext: source.audioContext,
      nowRoomTimeMs: source.nowRoomTimeMs,
      roomTimeMsToContextTime: source.roomTimeMsToContextTime,
      localPerformanceMsToContextTime: source.localPerformanceMsToContextTime,
      runtime: runtime.codecRuntime,
      timelineEvidence: evidence,
    }),
});

const MANIFEST_CODEC_HANDLERS = Object.freeze({
  'adts-aac-lc': ADTS_HANDLER,
  'mp3-no-frame-count': MP3_HANDLER,
} satisfies {
  readonly [Codec in CodecTimelineManifestCodec]: Readonly<StaticManifestCodecHandler<Codec>>;
});

/**
 * Select one member of the closed handler set and snapshot its runtime before
 * any source lease is acquired. There is deliberately no registration API.
 */
export function bindManifestCodecHandler(
  manifest: Readonly<CodecTimelineManifest>,
  runtimeOptionOwner: unknown,
): Readonly<BoundManifestCodecHandler> {
  const options = snapshotRuntimeOptions(runtimeOptionOwner);
  switch (manifest.codec) {
    case 'adts-aac-lc':
      return MANIFEST_CODEC_HANDLERS['adts-aac-lc'].bind(manifest, options);
    case 'mp3-no-frame-count':
      return MANIFEST_CODEC_HANDLERS['mp3-no-frame-count'].bind(manifest, options);
  }
}
