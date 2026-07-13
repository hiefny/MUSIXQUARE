/** Codec-neutral decoded media shape consumed by the bounded PCM renderer. */
export interface StreamingDecoderMediaInfo {
  /** Audible media-domain sample rate after codec delay/padding normalization. */
  readonly mediaSampleRateHz: number;
  readonly channelCount: number;
  /** Audible media-domain frames; container padding must not be included. */
  readonly totalMediaFrames: number;
}

export type StreamingDecoderFatalHandler = (code: string, cause?: unknown) => void;

export type StreamingDecoderGenerationStoppedHandler = (generation: number, cause: Error) => void;

export interface StreamingDecoderOpenOptions {
  /** One prepare attempt. Aborting it must not outlive the owning source teardown. */
  readonly signal: AbortSignal;
  /** Whole playback-source lifetime used by the encoded-source bridge. */
  readonly lifetimeSignal: AbortSignal;
  /** Synchronous fail-closed notification for errors after open or generation readiness. */
  readonly onFatal: StreamingDecoderFatalHandler;
  /** Reports an unexpected stop while the renderer may still await its prime barrier. */
  readonly onGenerationStopped: StreamingDecoderGenerationStoppedHandler;
}

export interface StreamingDecoderGenerationRequest {
  readonly generation: number;
  /** Exact audible media-domain frame requested by the product timeline. */
  readonly targetMediaFrame: number;
  readonly outputSampleRateHz: number;
  /**
   * Ownership transfers to the adapter when the decoder command is accepted.
   * The worker owns a successfully transferred endpoint; the adapter closes an
   * endpoint whose transfer fails.
   */
  readonly pcmPort: MessagePort;
  readonly signal: AbortSignal;
}

/**
 * Codec/container boundary below one bounded PCM renderer.
 *
 * Implementations own their exact EncodedAudioSource, parser/index state,
 * worker, and source-port broker. They must remain constructor-side-effect
 * free: native resources and source reads begin only in open().
 */
export interface StreamingDecoderAdapter {
  readonly info: Readonly<StreamingDecoderMediaInfo>;
  readonly opened: boolean;

  /** Opens the one encoded-source bridge and resolves after its exact acknowledgement. */
  open(options: StreamingDecoderOpenOptions): Promise<void>;
  /** Resolves only after the exact decoder generation reports readiness. */
  startGeneration(request: StreamingDecoderGenerationRequest): Promise<void>;
  /** Best-effort stop; protocol failures are reported through onFatal. */
  stopGeneration(generation: number): void;
  /** Idempotent terminal ownership boundary; closes the encoded source exactly once. */
  close(): Promise<void>;
}
