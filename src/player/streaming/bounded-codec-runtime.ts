import type { BoundedStreamingPlaybackRuntime } from '../backends/bounded-streaming-playback-source.ts';

/** Browser-boundary factories shared by every bounded codec wrapper. */
export interface BoundedStreamingCodecRuntime extends BoundedStreamingPlaybackRuntime {
  readonly createWorker: () => Worker;
}
