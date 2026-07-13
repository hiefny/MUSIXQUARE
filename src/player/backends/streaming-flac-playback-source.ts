import { loadPcmRingWorklet } from '../../audio/worklet-loader.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  BoundedStreamingPlaybackSource,
  type BoundedStreamingPlaybackRuntime,
} from './bounded-streaming-playback-source.ts';
import { FlacDecoderAdapter } from '../flac/flac-decoder-adapter.ts';
import type { FlacMetadata } from '../flac/metadata.ts';
import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';

type WorkerFactory = () => Worker;
type WorkletNodeFactory = (
  context: AudioContext,
  name: string,
  options: AudioWorkletNodeOptions,
) => AudioWorkletNode;
type MessageChannelFactory = () => MessageChannel;

export interface StreamingFlacPlaybackRuntime {
  readonly loadWorklet: (context: AudioContext) => Promise<void>;
  readonly createWorker: WorkerFactory;
  readonly createWorkletNode: WorkletNodeFactory;
  readonly createMessageChannel: MessageChannelFactory;
}

export interface StreamingFlacPlaybackSourceOptions {
  readonly queueItemId: QueueItemId;
  /** Exact encoded source; ownership transfers to this playback source. */
  readonly encodedSource: EncodedAudioSource;
  readonly metadata: FlacMetadata;
  readonly audioContext: AudioContext;
  /** Authoritative monotonic room clock. It must not derive from AudioContext.currentTime. */
  readonly nowRoomTimeMs: () => number;
  readonly roomTimeMsToContextTime: (roomTimeMs: number) => number;
  readonly localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;
  readonly prepareTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  /** Explicit runtime seam for deterministic browser-boundary tests. */
  readonly runtime?: Partial<StreamingFlacPlaybackRuntime>;
}

const defaultRuntime: StreamingFlacPlaybackRuntime = {
  loadWorklet: loadPcmRingWorklet,
  createWorker: () =>
    new Worker(new URL('../../workers/flac-stream.worker.ts', import.meta.url), {
      type: 'module',
      name: 'musixquare-flac-stream-v2',
    }),
  createWorkletNode: (context, name, options) => new AudioWorkletNode(context, name, options),
  createMessageChannel: () => new MessageChannel(),
};

/** Public native-FLAC wrapper over the codec-neutral bounded streaming backend. */
export class StreamingFlacPlaybackSource extends BoundedStreamingPlaybackSource {
  constructor(options: StreamingFlacPlaybackSourceOptions) {
    const createMessageChannel =
      options.runtime?.createMessageChannel ?? defaultRuntime.createMessageChannel;
    const createWorker = options.runtime?.createWorker ?? defaultRuntime.createWorker;
    const rendererRuntime: BoundedStreamingPlaybackRuntime = {
      loadWorklet: options.runtime?.loadWorklet ?? defaultRuntime.loadWorklet,
      createWorkletNode: options.runtime?.createWorkletNode ?? defaultRuntime.createWorkletNode,
      createMessageChannel,
    };
    super({
      queueItemId: options.queueItemId,
      createDecoder: () =>
        new FlacDecoderAdapter({
          encodedSource: options.encodedSource,
          metadata: options.metadata,
          runtime: { createWorker, createMessageChannel },
        }),
      audioContext: options.audioContext,
      nowRoomTimeMs: options.nowRoomTimeMs,
      roomTimeMsToContextTime: options.roomTimeMsToContextTime,
      localPerformanceMsToContextTime: options.localPerformanceMsToContextTime,
      prepareTimeoutMs: options.prepareTimeoutMs,
      commandTimeoutMs: options.commandTimeoutMs,
      runtime: rendererRuntime,
    });
  }
}
