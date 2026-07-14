import { loadPcmRingWorklet } from '../../audio/worklet-loader.ts';
import type { QueueItemId } from '../../types/index.ts';
import {
  BoundedStreamingPlaybackSource,
  type BoundedStreamingPlaybackRuntime,
} from './bounded-streaming-playback-source.ts';
import { Mp3DecoderAdapter } from '../mp3/decoder-adapter.ts';
import type { Mp3DecoderTimelineEvidence } from '../mp3/decoder-timeline-evidence.ts';
import type { Mp3Metadata } from '../mp3/metadata.ts';
import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';
import type { BoundedStreamingCodecRuntime } from '../streaming/bounded-codec-runtime.ts';

interface StreamingMp3PlaybackSourceCommonOptions {
  readonly queueItemId: QueueItemId;
  /** Exact encoded source; ownership transfers after this constructor succeeds. */
  readonly encodedSource: EncodedAudioSource;
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

export interface StreamingMp3PlaybackSourceMetadataOptions extends StreamingMp3PlaybackSourceCommonOptions {
  /** Scanner-verified, audible-timeline-normalized MPEG Layer III metadata. */
  readonly metadata: Readonly<Mp3Metadata>;
  readonly timelineEvidence?: never;
}

export interface StreamingMp3PlaybackSourceTimelineEvidenceOptions extends StreamingMp3PlaybackSourceCommonOptions {
  readonly metadata?: never;
  /** Detached planning data; its owner must separately retain source/admission authority. */
  readonly timelineEvidence: Readonly<Mp3DecoderTimelineEvidence>;
}

export type StreamingMp3PlaybackSourceOptions =
  | StreamingMp3PlaybackSourceMetadataOptions
  | StreamingMp3PlaybackSourceTimelineEvidenceOptions;

const defaultRuntime: BoundedStreamingCodecRuntime = {
  loadWorklet: loadPcmRingWorklet,
  createWorker: () =>
    new Worker(new URL('../../workers/mp3-stream.worker.ts', import.meta.url), {
      type: 'module',
      name: 'musixquare-mp3-stream-v1',
    }),
  createWorkletNode: (context, name, options) => new AudioWorkletNode(context, name, options),
  createMessageChannel: () => new MessageChannel(),
};

/** Public MPEG Layer III wrapper over the codec-neutral bounded streaming backend. */
export class StreamingMp3PlaybackSource extends BoundedStreamingPlaybackSource {
  constructor(options: StreamingMp3PlaybackSourceOptions) {
    const hasMetadata = Object.hasOwn(options, 'metadata');
    const hasTimelineEvidence = Object.hasOwn(options, 'timelineEvidence');
    if (hasMetadata === hasTimelineEvidence) {
      throw new TypeError(
        'Streaming MP3 playback source requires exactly one of metadata or timelineEvidence',
      );
    }
    const decoderTimelineInput = hasMetadata
      ? { metadata: (options as StreamingMp3PlaybackSourceMetadataOptions).metadata }
      : {
          timelineEvidence: (options as StreamingMp3PlaybackSourceTimelineEvidenceOptions)
            .timelineEvidence,
        };
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
        new Mp3DecoderAdapter({
          encodedSource: options.encodedSource,
          ...decoderTimelineInput,
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
