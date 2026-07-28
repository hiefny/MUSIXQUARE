import {
  PCM_STREAM_MAX_CHANNELS,
  PCM_STREAM_MAX_MESSAGE_FRAMES,
} from '../streaming/pcm-stream-protocol.js';
import type { LinearPcmSampleLayout } from './sample-format.js';

/** EncodedSourcePortBroker's exact physical read ceiling. */
export const LINEAR_PCM_STREAM_MAX_READ_BYTES = 64 * 1_024;
export const LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES = PCM_STREAM_MAX_MESSAGE_FRAMES;
export const LINEAR_PCM_STREAM_MAX_CHANNELS = PCM_STREAM_MAX_CHANNELS;
export const LINEAR_PCM_STREAM_MAX_SAMPLE_RATE_HZ = 1_000_000;

/** Container-neutral geometry needed by the bounded linear-PCM worker path. */
export interface LinearPcmStreamDescriptor extends LinearPcmSampleLayout {
  readonly sourceSampleRate: number;
  readonly outputSampleRate: number;
  readonly dataOffset: number;
  readonly dataBytes: number;
  readonly logicalFileBytes: number;
  readonly totalSourceFrames: number;
  readonly targetSourceFrame: number;
}

export interface LinearPcmInputReadPlan {
  readonly sourceFrame: number;
  readonly byteOffset: number;
  readonly frames: number;
  readonly bytes: number;
  readonly final: boolean;
}
