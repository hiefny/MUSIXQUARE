import {
  type PcmStreamGeneration,
  type PcmSupplyMessage,
} from '../streaming/pcm-stream-protocol.ts';
import {
  LINEAR_PCM_STREAM_MAX_CHANNELS,
  LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES,
  LINEAR_PCM_STREAM_MAX_READ_BYTES,
  type LinearPcmStreamDescriptor,
} from '../linear-pcm/stream-protocol.js';
import type { WavePcmEncoding } from './metadata.ts';

/** Control-channel protocol for the WAVE decoder worker. */
export const WAVE_STREAM_PROTOCOL_VERSION = 1 as const;
/** EncodedSourcePortBroker's exact physical read ceiling. */
export const WAVE_STREAM_MAX_READ_BYTES = LINEAR_PCM_STREAM_MAX_READ_BYTES;
export const WAVE_STREAM_MAX_PCM_MESSAGE_FRAMES = LINEAR_PCM_STREAM_MAX_MESSAGE_FRAMES;
export const WAVE_STREAM_MAX_CHANNELS = LINEAR_PCM_STREAM_MAX_CHANNELS;
export const WAVE_STREAM_MAX_SOURCE_IDENTITY_LENGTH = 512;

export type WaveSourceLifetimeGeneration = number;
export type WaveDecoderGeneration = PcmStreamGeneration;

/** Immutable, plain-data contract independently validated inside the worker. */
export interface WaveStreamDescriptor extends LinearPcmStreamDescriptor {
  readonly format: 'wave-pcm';
  readonly encoding: WavePcmEncoding;
}

export interface WaveSourceOpenMessage {
  readonly protocolVersion: typeof WAVE_STREAM_PROTOCOL_VERSION;
  readonly type: 'open-source';
  readonly sourceLifetimeGeneration: WaveSourceLifetimeGeneration;
  readonly sourceSize: number;
  readonly sourceIdentity: string;
  readonly sourcePort: MessagePort;
}

export interface WaveDecoderInitMessage {
  readonly protocolVersion: typeof WAVE_STREAM_PROTOCOL_VERSION;
  readonly type: 'init-decoder';
  readonly sourceLifetimeGeneration: WaveSourceLifetimeGeneration;
  readonly decoderGeneration: WaveDecoderGeneration;
  readonly descriptor: WaveStreamDescriptor;
  readonly pcmPort: MessagePort;
}

export interface WaveDecoderStopMessage {
  readonly protocolVersion: typeof WAVE_STREAM_PROTOCOL_VERSION;
  readonly type: 'stop-decoder';
  readonly sourceLifetimeGeneration: WaveSourceLifetimeGeneration;
  readonly decoderGeneration: WaveDecoderGeneration;
}

export interface WaveSourceCloseMessage {
  readonly protocolVersion: typeof WAVE_STREAM_PROTOCOL_VERSION;
  readonly type: 'close-source';
  readonly sourceLifetimeGeneration: WaveSourceLifetimeGeneration;
}

export type WaveDecoderCommand =
  | WaveSourceOpenMessage
  | WaveDecoderInitMessage
  | WaveDecoderStopMessage
  | WaveSourceCloseMessage;

export type WaveDecoderEvent =
  | {
      readonly protocolVersion: typeof WAVE_STREAM_PROTOCOL_VERSION;
      readonly type: 'source-opened';
      readonly sourceLifetimeGeneration: WaveSourceLifetimeGeneration;
      readonly sourceSize: number;
      readonly sourceIdentity: string;
    }
  | {
      readonly protocolVersion: typeof WAVE_STREAM_PROTOCOL_VERSION;
      readonly type: 'source-closed';
      readonly sourceLifetimeGeneration: WaveSourceLifetimeGeneration;
    }
  | {
      readonly protocolVersion: typeof WAVE_STREAM_PROTOCOL_VERSION;
      readonly type: 'source-error';
      readonly sourceLifetimeGeneration: WaveSourceLifetimeGeneration;
      readonly code: string;
    }
  | {
      readonly protocolVersion: typeof WAVE_STREAM_PROTOCOL_VERSION;
      readonly type: 'decoder-ready';
      readonly sourceLifetimeGeneration: WaveSourceLifetimeGeneration;
      readonly decoderGeneration: WaveDecoderGeneration;
      readonly descriptor: WaveStreamDescriptor;
    }
  | {
      readonly protocolVersion: typeof WAVE_STREAM_PROTOCOL_VERSION;
      readonly type: 'decode-progress';
      readonly sourceLifetimeGeneration: WaveSourceLifetimeGeneration;
      readonly decoderGeneration: WaveDecoderGeneration;
      readonly decodedInputBytes: number;
      readonly decodedSourceFrames: number;
      readonly producedOutputFrames: number;
    }
  | {
      readonly protocolVersion: typeof WAVE_STREAM_PROTOCOL_VERSION;
      readonly type: 'decoder-eof';
      readonly sourceLifetimeGeneration: WaveSourceLifetimeGeneration;
      readonly decoderGeneration: WaveDecoderGeneration;
      readonly decodedInputBytes: number;
      readonly decodedSourceFrames: number;
      readonly producedOutputFrames: number;
    }
  | {
      readonly protocolVersion: typeof WAVE_STREAM_PROTOCOL_VERSION;
      readonly type: 'decoder-stopped';
      readonly sourceLifetimeGeneration: WaveSourceLifetimeGeneration;
      readonly decoderGeneration: WaveDecoderGeneration;
    }
  | {
      readonly protocolVersion: typeof WAVE_STREAM_PROTOCOL_VERSION;
      readonly type: 'decoder-error';
      readonly sourceLifetimeGeneration: WaveSourceLifetimeGeneration;
      readonly decoderGeneration: WaveDecoderGeneration;
      readonly code: string;
      readonly message: string;
    };

export type { PcmSupplyMessage };

export function isWaveDecoderGeneration(value: unknown): value is WaveDecoderGeneration {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export const isWaveSourceLifetimeGeneration = isWaveDecoderGeneration;

export function isWaveSourceSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isWaveSourceIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= WAVE_STREAM_MAX_SOURCE_IDENTITY_LENGTH
  );
}
