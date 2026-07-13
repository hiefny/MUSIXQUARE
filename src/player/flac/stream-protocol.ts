import {
  PCM_STREAM_MAX_CHANNELS,
  PCM_STREAM_PROTOCOL_VERSION,
  isPcmStreamGeneration,
  type PcmStreamGeneration,
} from '../streaming/pcm-stream-protocol.ts';

export {
  PCM_STREAM_MAX_CHANNELS,
  PCM_STREAM_MAX_MESSAGE_FRAMES,
  PCM_STREAM_PROTOCOL_VERSION,
  isPcmStreamGeneration,
  type PcmRingCommand,
  type PcmRingEvent,
  type PcmRingState,
  type PcmStreamGeneration,
  type PcmStreamRunIdentity,
  type PcmSupplyMessage,
} from '../streaming/pcm-stream-protocol.ts';

export const FLAC_STREAM_PROTOCOL_VERSION = PCM_STREAM_PROTOCOL_VERSION;
export const FLAC_STREAM_MAX_CHANNELS = PCM_STREAM_MAX_CHANNELS;
export const FLAC_STREAM_INPUT_CHUNK_BYTES = 64 * 1024;

/** One immutable encoded-source bridge for the whole playback-source lifetime. */
export type FlacSourceLifetimeGeneration = number;
/** One decoder/ring incarnation; seeks advance this without replacing the source bridge. */
export type FlacDecoderGeneration = PcmStreamGeneration;
/** AudioWorklet-facing alias; every ring generation is one decoder generation. */
export type FlacStreamGeneration = FlacDecoderGeneration;

export interface FlacStreamDescriptor {
  readonly sourceSampleRate: number;
  readonly outputSampleRate: number;
  readonly channels: number;
  readonly bitDepth: number;
  readonly totalSourceSamples: number;
  /** Absolute byte offset immediately after native FLAC metadata. */
  readonly firstAudioFrameOffset: number;
  /** Exact absolute source-domain sample requested by the playback timeline. */
  readonly targetSourceSample: number;
  /** Verified frame boundary at or before targetSourceSample. */
  readonly decodeAnchorByteOffset: number;
  /** Absolute source-domain sample at decodeAnchorByteOffset. */
  readonly decodeAnchorSourceSample: number;
  readonly minBlockSize: number;
  readonly maxBlockSize: number;
  /** STREAMINFO may report zero when an encoded-frame size is unknown. */
  readonly minFrameSize: number;
  /** STREAMINFO may report zero when an encoded-frame size is unknown. */
  readonly maxFrameSize: number;
}

export interface FlacSourceOpenMessage {
  readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
  readonly type: 'open-source';
  readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
  readonly sourceSize: number;
  readonly sourceIdentity: string;
  readonly sourcePort: MessagePort;
}

export interface FlacDecoderInitMessage {
  readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
  readonly type: 'init-decoder';
  readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
  readonly decoderGeneration: FlacDecoderGeneration;
  readonly descriptor: FlacStreamDescriptor;
  readonly pcmPort: MessagePort;
}

export interface FlacDecoderStopMessage {
  readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
  readonly type: 'stop-decoder';
  readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
  readonly decoderGeneration: FlacDecoderGeneration;
}

export interface FlacSourceCloseMessage {
  readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
  readonly type: 'close-source';
  readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
}

export type FlacDecoderCommand =
  | FlacSourceOpenMessage
  | FlacDecoderInitMessage
  | FlacDecoderStopMessage
  | FlacSourceCloseMessage;

export type FlacDecoderEvent =
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'source-opened';
      readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
      readonly sourceSize: number;
      readonly sourceIdentity: string;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'source-closed';
      readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'source-error';
      readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
      readonly code: string;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'decoder-ready';
      readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
      readonly decoderGeneration: FlacDecoderGeneration;
      readonly descriptor: FlacStreamDescriptor;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'decode-progress';
      readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
      readonly decoderGeneration: FlacDecoderGeneration;
      readonly decodedInputBytes: number;
      readonly decodedSourceSamples: number;
      readonly producedOutputFrames: number;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'decoder-eof';
      readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
      readonly decoderGeneration: FlacDecoderGeneration;
      readonly decodedInputBytes: number;
      readonly decodedSourceSamples: number;
      readonly producedOutputFrames: number;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'decoder-stopped';
      readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
      readonly decoderGeneration: FlacDecoderGeneration;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'frame-index-point';
      readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
      readonly decoderGeneration: FlacDecoderGeneration;
      /** Absolute source-domain PCM sample at a verified frame boundary. */
      readonly sourceSample: number;
      /** Absolute byte offset of that native FLAC frame. */
      readonly byteOffset: number;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'decode-anchor-rejected';
      readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
      readonly decoderGeneration: FlacDecoderGeneration;
      /** Exact unverified SEEKTABLE candidate that failed scanner validation. */
      readonly sourceSample: number;
      readonly byteOffset: number;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'decoder-error';
      readonly sourceLifetimeGeneration: FlacSourceLifetimeGeneration;
      readonly decoderGeneration: FlacDecoderGeneration;
      readonly code: string;
      readonly message: string;
    };

export function isFlacStreamGeneration(value: unknown): value is FlacStreamGeneration {
  return isPcmStreamGeneration(value);
}

export const isFlacDecoderGeneration = isFlacStreamGeneration;

export function isFlacSourceLifetimeGeneration(
  value: unknown,
): value is FlacSourceLifetimeGeneration {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isFlacSourceSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
