import { loadPcmRingWorklet } from '../../audio/worklet-loader.ts';
import type { QueueItemId } from '../../types/index.ts';
import { M4aAacDecoderAdapter } from '../m4a/decoder-adapter.ts';
import type { M4aAacDecoderBackendId } from '../m4a/decoder-protocol.ts';
import type { M4aAacLcManifest } from '../m4a/metadata.ts';
import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';
import type { BoundedStreamingCodecRuntime } from '../streaming/bounded-codec-runtime.ts';
import {
  BoundedStreamingPlaybackSource,
  type BoundedStreamingPlaybackRuntime,
} from './bounded-streaming-playback-source.ts';

export interface StreamingM4aAacPlaybackSourceOptions {
  readonly queueItemId: QueueItemId;
  /** Exact source bound by the canonical manifest; ownership transfers after construction. */
  readonly encodedSource: EncodedAudioSource;
  /** Canonical non-fragmented M4A AAC-LC manifest issued by the bounded metadata reader. */
  readonly manifest: Readonly<M4aAacLcManifest>;
  /** Exact admitted cohort. The adapter and Worker never substitute another backend. */
  readonly backendId: M4aAacDecoderBackendId;
  readonly audioContext: AudioContext;
  /** Authoritative monotonic room clock. It must not derive from AudioContext.currentTime. */
  readonly nowRoomTimeMs: () => number;
  readonly roomTimeMsToContextTime: (roomTimeMs: number) => number;
  readonly localPerformanceMsToContextTime: (localPerformanceTimeMs: number) => number;
  readonly prepareTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  /** Explicit runtime seam for deterministic browser-boundary tests. */
  readonly runtime?: Partial<BoundedStreamingCodecRuntime>;
}

const defaultRuntime: BoundedStreamingCodecRuntime = {
  loadWorklet: loadPcmRingWorklet,
  createWorker: () =>
    new Worker(new URL('../../workers/m4a-aac-stream.worker.ts', import.meta.url), {
      type: 'module',
      name: 'musixquare-m4a-aac-stream-v1',
    }),
  createWorkletNode: (context, name, options) => new AudioWorkletNode(context, name, options),
  createMessageChannel: () => new MessageChannel(),
};

/** Product-unreachable M4A AAC-LC wrapper over the common bounded streaming renderer. */
export class StreamingM4aAacPlaybackSource extends BoundedStreamingPlaybackSource {
  constructor(options: StreamingM4aAacPlaybackSourceOptions) {
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
        new M4aAacDecoderAdapter({
          encodedSource: options.encodedSource,
          manifest: options.manifest,
          backendId: options.backendId,
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
