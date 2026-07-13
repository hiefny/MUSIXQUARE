// Keep this worker/worklet-facing protocol on leaf primitives. A playback
// revision is a JSON-safe non-negative number; importing the product timeline
// here would pull DOM-only application types into isolated audio runtimes.
type PlaybackRevision = number;

export const PCM_STREAM_PROTOCOL_VERSION = 2 as const;
export const PCM_STREAM_MAX_CHANNELS = 8;
export const PCM_STREAM_MAX_MESSAGE_FRAMES = 32_768;

/** One decoder/ring incarnation. A seek advances this generation. */
export type PcmStreamGeneration = number;

/** Exact playback attempt rendered by one PCM ring incarnation. */
export interface PcmStreamRunIdentity {
  readonly revision: PlaybackRevision;
  readonly runId: string;
  readonly rendezvousId: string;
}

/** Worklet-to-decoder demand; at most one request is outstanding per ring. */
export interface PcmDemandMessage {
  readonly protocolVersion: typeof PCM_STREAM_PROTOCOL_VERSION;
  readonly type: 'need';
  readonly generation: PcmStreamGeneration;
  readonly maxFrames: number;
}

/** Decoder-to-worklet PCM supply protocol shared by every streaming codec. */
export type PcmSupplyMessage =
  | {
      readonly protocolVersion: typeof PCM_STREAM_PROTOCOL_VERSION;
      readonly type: 'pcm';
      readonly generation: PcmStreamGeneration;
      readonly frames: number;
      readonly channels: ArrayBuffer[];
      readonly final: boolean;
    }
  | {
      readonly protocolVersion: typeof PCM_STREAM_PROTOCOL_VERSION;
      readonly type: 'eof';
      readonly generation: PcmStreamGeneration;
    }
  | {
      readonly protocolVersion: typeof PCM_STREAM_PROTOCOL_VERSION;
      readonly type: 'source-error';
      readonly generation: PcmStreamGeneration;
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
  readonly protocolVersion: typeof PCM_STREAM_PROTOCOL_VERSION;
  readonly generation: PcmStreamGeneration;
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
      PcmStreamRunIdentity & {
        readonly type: 'arm';
        readonly targetFrame: number;
        readonly fadeInFrames: number;
      })
  | (PcmRingGenerationCommand &
      PcmStreamRunIdentity & {
        readonly type: 'finalize';
      })
  | (PcmRingGenerationCommand & {
      readonly type: 'cancel';
      readonly revision?: PlaybackRevision;
      readonly runId?: string;
      readonly rendezvousId?: string;
    })
  | (PcmRingGenerationCommand &
      PcmStreamRunIdentity & {
        readonly type: 'pause';
        readonly targetFrame: number;
      })
  | (PcmRingGenerationCommand & { readonly type: 'stop' });

interface PcmRingGenerationEvent {
  readonly protocolVersion: typeof PCM_STREAM_PROTOCOL_VERSION;
  readonly generation: PcmStreamGeneration;
}

export type PcmRingEvent =
  | (PcmRingGenerationEvent & {
      readonly type: 'primed';
      readonly bufferedFrames: number;
      readonly sampleRate: number;
      readonly channels: number;
    })
  | (PcmRingGenerationEvent &
      PcmStreamRunIdentity & {
        readonly type: 'armed';
        readonly targetFrame: number;
      })
  | (PcmRingGenerationEvent &
      PcmStreamRunIdentity & {
        readonly type: 'finalized';
        readonly targetFrame: number;
      })
  | (PcmRingGenerationEvent &
      PcmStreamRunIdentity & {
        readonly type: 'started';
        readonly targetFrame: number;
        readonly actualStartFrame: number;
        readonly mediaFrame: number;
      })
  | (PcmRingGenerationEvent &
      PcmStreamRunIdentity & {
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

export function isPcmStreamGeneration(value: unknown): value is PcmStreamGeneration {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

type PcmProtocolRecord = Readonly<Record<string, unknown>>;

/**
 * Snapshot an exact structured-clone-style record without invoking accessors.
 * This keeps local EOF responders and codec Workers on the same trust boundary.
 */
function snapshotPcmProtocolRecord(value: unknown): PcmProtocolRecord | null {
  if (typeof value !== 'object' || value === null) return null;

  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Reflect.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== null && prototype !== Object.prototype) return null;

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || Object.prototype.hasOwnProperty.call(snapshot, key)) return null;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

/** Strict canonical parser for the only Worklet-to-decoder PCM message. */
export function parsePcmDemandMessage(value: unknown): Readonly<PcmDemandMessage> | null {
  const snapshot = snapshotPcmProtocolRecord(value);
  if (!snapshot) return null;
  const keys = Object.keys(snapshot);
  if (
    keys.length !== 4 ||
    !Object.prototype.hasOwnProperty.call(snapshot, 'protocolVersion') ||
    !Object.prototype.hasOwnProperty.call(snapshot, 'type') ||
    !Object.prototype.hasOwnProperty.call(snapshot, 'generation') ||
    !Object.prototype.hasOwnProperty.call(snapshot, 'maxFrames') ||
    snapshot.protocolVersion !== PCM_STREAM_PROTOCOL_VERSION ||
    snapshot.type !== 'need' ||
    !isPcmStreamGeneration(snapshot.generation) ||
    typeof snapshot.maxFrames !== 'number' ||
    !Number.isSafeInteger(snapshot.maxFrames) ||
    snapshot.maxFrames < 1 ||
    snapshot.maxFrames > PCM_STREAM_MAX_MESSAGE_FRAMES
  ) {
    return null;
  }
  return Object.freeze({
    protocolVersion: PCM_STREAM_PROTOCOL_VERSION,
    type: 'need',
    generation: snapshot.generation,
    maxFrames: snapshot.maxFrames,
  });
}
