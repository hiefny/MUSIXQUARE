import {
  isPcmStreamGeneration,
  type PcmStreamGeneration,
  type PcmSupplyMessage,
} from '../streaming/pcm-stream-protocol.js';
import type { LinearPcmStreamDescriptor } from './stream-protocol.js';

/** Control protocol shared by every fixed-frame linear-PCM container. */
export const LINEAR_PCM_DECODER_PROTOCOL_VERSION = 2 as const;

export type LinearPcmSourceLifetimeGeneration = number;
export type LinearPcmDecoderGeneration = PcmStreamGeneration;

/** Exact worker descriptor after a container parser has normalized its geometry. */
export interface LinearPcmDecoderDescriptor extends LinearPcmStreamDescriptor {
  readonly format: 'linear-pcm';
}

export const LINEAR_PCM_DECODER_DESCRIPTOR_KEYS = [
  'format',
  'sourceSampleRate',
  'outputSampleRate',
  'channels',
  'encoding',
  'containerBitsPerSample',
  'validBitsPerSample',
  'blockAlign',
  'dataOffset',
  'dataBytes',
  'logicalFileBytes',
  'totalSourceFrames',
  'targetSourceFrame',
] as const satisfies readonly (keyof LinearPcmDecoderDescriptor)[];

export interface LinearPcmSourceOpenMessage {
  readonly protocolVersion: typeof LINEAR_PCM_DECODER_PROTOCOL_VERSION;
  readonly type: 'open-source';
  readonly sourceLifetimeGeneration: LinearPcmSourceLifetimeGeneration;
  readonly sourceSize: number;
  readonly sourceIdentity: string;
  readonly sourcePort: MessagePort;
}

export interface LinearPcmDecoderInitMessage {
  readonly protocolVersion: typeof LINEAR_PCM_DECODER_PROTOCOL_VERSION;
  readonly type: 'init-decoder';
  readonly sourceLifetimeGeneration: LinearPcmSourceLifetimeGeneration;
  readonly decoderGeneration: LinearPcmDecoderGeneration;
  readonly descriptor: LinearPcmDecoderDescriptor;
  readonly pcmPort: MessagePort;
}

export interface LinearPcmDecoderStopMessage {
  readonly protocolVersion: typeof LINEAR_PCM_DECODER_PROTOCOL_VERSION;
  readonly type: 'stop-decoder';
  readonly sourceLifetimeGeneration: LinearPcmSourceLifetimeGeneration;
  readonly decoderGeneration: LinearPcmDecoderGeneration;
}

export interface LinearPcmSourceCloseMessage {
  readonly protocolVersion: typeof LINEAR_PCM_DECODER_PROTOCOL_VERSION;
  readonly type: 'close-source';
  readonly sourceLifetimeGeneration: LinearPcmSourceLifetimeGeneration;
}

export type LinearPcmDecoderCommand =
  | LinearPcmSourceOpenMessage
  | LinearPcmDecoderInitMessage
  | LinearPcmDecoderStopMessage
  | LinearPcmSourceCloseMessage;

export type LinearPcmDecoderEvent =
  | {
      readonly protocolVersion: typeof LINEAR_PCM_DECODER_PROTOCOL_VERSION;
      readonly type: 'source-opened';
      readonly sourceLifetimeGeneration: LinearPcmSourceLifetimeGeneration;
      readonly sourceSize: number;
      readonly sourceIdentity: string;
    }
  | {
      readonly protocolVersion: typeof LINEAR_PCM_DECODER_PROTOCOL_VERSION;
      readonly type: 'source-closed';
      readonly sourceLifetimeGeneration: LinearPcmSourceLifetimeGeneration;
    }
  | {
      readonly protocolVersion: typeof LINEAR_PCM_DECODER_PROTOCOL_VERSION;
      readonly type: 'source-error';
      readonly sourceLifetimeGeneration: LinearPcmSourceLifetimeGeneration;
      readonly code: string;
    }
  | {
      readonly protocolVersion: typeof LINEAR_PCM_DECODER_PROTOCOL_VERSION;
      readonly type: 'decoder-ready';
      readonly sourceLifetimeGeneration: LinearPcmSourceLifetimeGeneration;
      readonly decoderGeneration: LinearPcmDecoderGeneration;
      readonly descriptor: LinearPcmDecoderDescriptor;
    }
  | {
      readonly protocolVersion: typeof LINEAR_PCM_DECODER_PROTOCOL_VERSION;
      readonly type: 'decode-progress' | 'decoder-eof';
      readonly sourceLifetimeGeneration: LinearPcmSourceLifetimeGeneration;
      readonly decoderGeneration: LinearPcmDecoderGeneration;
      readonly decodedInputBytes: number;
      readonly decodedSourceFrames: number;
      readonly producedOutputFrames: number;
    }
  | {
      readonly protocolVersion: typeof LINEAR_PCM_DECODER_PROTOCOL_VERSION;
      readonly type: 'decoder-stopped';
      readonly sourceLifetimeGeneration: LinearPcmSourceLifetimeGeneration;
      readonly decoderGeneration: LinearPcmDecoderGeneration;
    }
  | {
      readonly protocolVersion: typeof LINEAR_PCM_DECODER_PROTOCOL_VERSION;
      /** Emitted only after pending demand, PCM port, carry, and resamplers are gone. */
      readonly type: 'decoder-retired';
      readonly sourceLifetimeGeneration: LinearPcmSourceLifetimeGeneration;
      readonly decoderGeneration: LinearPcmDecoderGeneration;
    }
  | {
      readonly protocolVersion: typeof LINEAR_PCM_DECODER_PROTOCOL_VERSION;
      /** Final worker ACK after every decoder and the encoded-source client retire. */
      readonly type: 'worker-retired';
      readonly sourceLifetimeGeneration: LinearPcmSourceLifetimeGeneration;
    }
  | {
      readonly protocolVersion: typeof LINEAR_PCM_DECODER_PROTOCOL_VERSION;
      readonly type: 'decoder-error';
      readonly sourceLifetimeGeneration: LinearPcmSourceLifetimeGeneration;
      readonly decoderGeneration: LinearPcmDecoderGeneration;
      readonly code: string;
      readonly message: string;
    };

export type { PcmSupplyMessage };

export function isLinearPcmDecoderGeneration(value: unknown): value is LinearPcmDecoderGeneration {
  return isPcmStreamGeneration(value);
}

export const isLinearPcmSourceLifetimeGeneration = isLinearPcmDecoderGeneration;

export function isLinearPcmSourceSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
