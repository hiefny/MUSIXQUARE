// Keep this worker-facing protocol on leaf primitives. PlaybackRevision is a
// JSON-safe non-negative number; importing the full playback timeline here
// would pull DOM-only application types into the isolated WebWorker build.
type PlaybackRevision = number;

export const FLAC_STREAM_PROTOCOL_VERSION = 1 as const;
export const FLAC_STREAM_MAX_CHANNELS = 8;
export const FLAC_STREAM_INPUT_CHUNK_BYTES = 64 * 1024;
export const FLAC_STREAM_MAX_PCM_MESSAGE_FRAMES = 32_768;

export type FlacStreamGeneration = number;

export interface FlacStreamRunIdentity {
  readonly revision: PlaybackRevision;
  readonly runId: string;
  readonly rendezvousId: string;
}

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

export interface FlacDecoderInitMessage {
  readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
  readonly type: 'init';
  readonly generation: FlacStreamGeneration;
  readonly blob: Blob;
  readonly descriptor: FlacStreamDescriptor;
  readonly pcmPort: MessagePort;
}

export interface FlacDecoderStopMessage {
  readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
  readonly type: 'stop';
  readonly generation: FlacStreamGeneration;
}

export type FlacDecoderCommand = FlacDecoderInitMessage | FlacDecoderStopMessage;

export type FlacDecoderEvent =
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'decoder-ready';
      readonly generation: FlacStreamGeneration;
      readonly descriptor: FlacStreamDescriptor;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'decode-progress';
      readonly generation: FlacStreamGeneration;
      readonly decodedInputBytes: number;
      readonly decodedSourceSamples: number;
      readonly producedOutputFrames: number;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'decoder-eof';
      readonly generation: FlacStreamGeneration;
      readonly decodedInputBytes: number;
      readonly decodedSourceSamples: number;
      readonly producedOutputFrames: number;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'decoder-stopped';
      readonly generation: FlacStreamGeneration;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'frame-index-point';
      readonly generation: FlacStreamGeneration;
      /** Absolute source-domain PCM sample at a verified frame boundary. */
      readonly sourceSample: number;
      /** Absolute byte offset of that native FLAC frame. */
      readonly byteOffset: number;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'decoder-error';
      readonly generation: FlacStreamGeneration;
      readonly code: string;
      readonly message: string;
    };

export type PcmSupplyMessage =
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'pcm';
      readonly generation: FlacStreamGeneration;
      readonly frames: number;
      readonly channels: ArrayBuffer[];
      readonly final: boolean;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'eof';
      readonly generation: FlacStreamGeneration;
    }
  | {
      readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
      readonly type: 'source-error';
      readonly generation: FlacStreamGeneration;
      readonly code: string;
    };

export type PcmRingState =
  | 'priming'
  | 'ready'
  | 'armed'
  | 'playing'
  | 'paused'
  | 'finished'
  | 'interrupted'
  | 'stopped';

interface PcmRingGenerationCommand {
  readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
  readonly generation: FlacStreamGeneration;
}

export type PcmRingCommand =
  | (PcmRingGenerationCommand & {
      readonly type: 'bind-pcm-port';
      readonly port: MessagePort;
    })
  | (PcmRingGenerationCommand & {
      readonly type: 'reset';
      readonly mediaFrame: number;
    })
  | (PcmRingGenerationCommand &
      FlacStreamRunIdentity & {
        readonly type: 'arm';
        readonly targetFrame: number;
        readonly fadeInFrames: number;
      })
  | (PcmRingGenerationCommand &
      FlacStreamRunIdentity & {
        readonly type: 'finalize';
      })
  | (PcmRingGenerationCommand & {
      readonly type: 'cancel';
      readonly revision?: PlaybackRevision;
      readonly runId?: string;
      readonly rendezvousId?: string;
    })
  | (PcmRingGenerationCommand &
      FlacStreamRunIdentity & {
        readonly type: 'pause';
        readonly targetFrame: number;
      })
  | (PcmRingGenerationCommand & { readonly type: 'stop' });

interface PcmRingGenerationEvent {
  readonly protocolVersion: typeof FLAC_STREAM_PROTOCOL_VERSION;
  readonly generation: FlacStreamGeneration;
}

export type PcmRingEvent =
  | (PcmRingGenerationEvent & {
      readonly type: 'primed';
      readonly bufferedFrames: number;
      readonly sampleRate: number;
      readonly channels: number;
    })
  | (PcmRingGenerationEvent &
      FlacStreamRunIdentity & {
        readonly type: 'armed';
        readonly targetFrame: number;
      })
  | (PcmRingGenerationEvent &
      FlacStreamRunIdentity & {
        readonly type: 'finalized';
        readonly targetFrame: number;
      })
  | (PcmRingGenerationEvent &
      FlacStreamRunIdentity & {
        readonly type: 'started';
        readonly targetFrame: number;
        readonly actualStartFrame: number;
        readonly mediaFrame: number;
      })
  | (PcmRingGenerationEvent &
      FlacStreamRunIdentity & {
        readonly type: 'paused';
        readonly targetFrame: number;
        readonly actualPauseFrame: number;
        readonly mediaFrame: number;
      })
  | (PcmRingGenerationEvent & {
      readonly type: 'finished';
      readonly mediaFrame: number;
    })
  | (PcmRingGenerationEvent & {
      readonly type: 'status';
      readonly state: PcmRingState;
      readonly bufferedFrames: number;
      readonly mediaFrame: number;
      readonly renderFrame: number;
      readonly underruns: number;
      readonly overflows: number;
    })
  | (PcmRingGenerationEvent & {
      readonly type: 'rejected' | 'interrupted';
      readonly code: string;
      readonly revision?: PlaybackRevision;
      readonly runId?: string;
      readonly rendezvousId?: string;
    });

export function isFlacStreamGeneration(value: unknown): value is FlacStreamGeneration {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
