import { loadPcmRingWorklet } from '../../audio/worklet-loader.ts';
import type { QueueItemId } from '../../types/index.ts';
import { AacDecoderAdapter } from '../aac/decoder-adapter.ts';
import type { AdtsDecoderTimelineEvidence } from '../aac/decoder-timeline-evidence.ts';
import type { AdtsFrameScanResult } from '../aac/frame-scanner.ts';
import type { EncodedAudioSource } from '../sources/encoded-audio-source.ts';
import type { BoundedStreamingCodecRuntime } from '../streaming/bounded-codec-runtime.ts';
import {
  BoundedStreamingPlaybackSource,
  type BoundedStreamingPlaybackRuntime,
} from './bounded-streaming-playback-source.ts';

interface StreamingAacPlaybackSourceCommonOptions {
  readonly queueItemId: QueueItemId;
  /** Exact source bound by the supplied evidence; ownership transfers after construction. */
  readonly encodedSource: EncodedAudioSource;
  /** This checkpoint admits only the native WebCodecs cohort. */
  readonly backendId: 'webcodecs';
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

export interface StreamingAacPlaybackSourceScanOptions extends StreamingAacPlaybackSourceCommonOptions {
  /** Complete scanner-issued evidence for one contiguous raw ADTS AAC source. */
  readonly scan: Readonly<AdtsFrameScanResult>;
  readonly timelineEvidence?: never;
}

export interface StreamingAacPlaybackSourceTimelineEvidenceOptions extends StreamingAacPlaybackSourceCommonOptions {
  readonly scan?: never;
  /** Detached planning data; its owner must separately retain source/admission authority. */
  readonly timelineEvidence: Readonly<AdtsDecoderTimelineEvidence>;
}

export type StreamingAacPlaybackSourceOptions =
  | StreamingAacPlaybackSourceScanOptions
  | StreamingAacPlaybackSourceTimelineEvidenceOptions;

/** Shared factory for both one-shot admission probes and playback generations. */
export function createDefaultAacStreamingWorker(): Worker {
  return new Worker(new URL('../../workers/aac-stream.worker.ts', import.meta.url), {
    type: 'module',
    name: 'musixquare-aac-stream-v1',
  });
}

const defaultRuntime: BoundedStreamingCodecRuntime = {
  loadWorklet: loadPcmRingWorklet,
  createWorker: createDefaultAacStreamingWorker,
  createWorkletNode: (context, name, options) => new AudioWorkletNode(context, name, options),
  createMessageChannel: () => new MessageChannel(),
};

/** Default-off raw ADTS AAC wrapper over the common bounded streaming renderer. */
export class StreamingAacPlaybackSource extends BoundedStreamingPlaybackSource {
  constructor(options: StreamingAacPlaybackSourceOptions) {
    const hasScan = Object.hasOwn(options, 'scan');
    const hasTimelineEvidence = Object.hasOwn(options, 'timelineEvidence');
    if (hasScan === hasTimelineEvidence) {
      throw new TypeError(
        'Streaming AAC playback source requires exactly one of scan or timelineEvidence',
      );
    }
    const decoderTimelineInput = hasScan
      ? { scan: (options as StreamingAacPlaybackSourceScanOptions).scan }
      : {
          timelineEvidence: (options as StreamingAacPlaybackSourceTimelineEvidenceOptions)
            .timelineEvidence,
        };
    const backendId = options.backendId;
    if (backendId !== 'webcodecs') {
      throw new TypeError('Streaming AAC backend must be exactly webcodecs');
    }
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
        new AacDecoderAdapter({
          encodedSource: options.encodedSource,
          ...decoderTimelineInput,
          backendId,
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
