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
   * Caller-owned until acceptPcmPortOwnership() returns successfully. Preflight,
   * descriptor, retirement-wait, and abort rejection must leave it untouched.
   * After acceptance the adapter must close it or conservatively account for an
   * uncertain worker transfer on every failure path.
   */
  readonly pcmPort: MessagePort;
  /**
   * Required one-shot ownership commit. For an accepted generation the adapter
   * invokes this exactly once, synchronously at the point where it commits. A
   * successful return transfers pcmPort ownership even if later setup throws.
   * It must not be retained or invoked after startGeneration settles or stops.
   */
  readonly acceptPcmPortOwnership: () => void;
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

  /**
   * Activates the adapter. A codec may open one lifetime bridge here or defer
   * a generation-scoped bridge until startGeneration().
   */
  open(options: StreamingDecoderOpenOptions): Promise<void>;
  /** Resolves only after the exact decoder generation reports readiness. */
  startGeneration(request: StreamingDecoderGenerationRequest): Promise<void>;
  /** Best-effort stop; protocol failures are reported through onFatal. */
  stopGeneration(generation: number): void;
  /** Idempotent terminal ownership boundary; closes the encoded source exactly once. */
  close(): Promise<void>;
}
