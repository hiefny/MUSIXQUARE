/** Local numeric counters only: no media, file names, identifiers, or retained resources. */
type ResourceKind = 'tracks' | 'readers' | 'playbacks' | 'workerCalls';

interface ResourceCounters {
  live: number;
  peak: number;
  opened: number;
  closed: number;
}

const resourceCounters = (): ResourceCounters => ({ live: 0, peak: 0, opened: 0, closed: 0 });
const resources: Record<ResourceKind, ResourceCounters> = {
  tracks: resourceCounters(),
  readers: resourceCounters(),
  playbacks: resourceCounters(),
  workerCalls: resourceCounters(),
};
const output = {
  supplyGaps: 0,
  longestSupplyGapMs: 0,
  readerRestarts: 0,
  longestReadMs: 0,
  peakPlaybackPcmBytes: 0,
};

function increment(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

/** Release only after the corresponding resource has actually finished closing. */
export function beginLargeAudioResource(kind: ResourceKind): () => void {
  const counter = resources[kind];
  counter.live = increment(counter.live);
  counter.opened = increment(counter.opened);
  counter.peak = Math.max(counter.peak, counter.live);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    counter.live = Math.max(0, counter.live - 1);
    counter.closed = increment(counter.closed);
  };
}

/** Missing scheduled output, not an acoustic measurement or a room-clock correction. */
export function recordLargeAudioSupplyGap(seconds: number, firstObservation: boolean): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  if (firstObservation) output.supplyGaps = increment(output.supplyGaps);
  output.longestSupplyGapMs = Math.max(output.longestSupplyGapMs, seconds * 1_000);
}

export function recordLargeAudioReaderRestart(): void {
  output.readerRestarts = increment(output.readerRestarts);
}

export function recordLargeAudioRead(milliseconds: number): void {
  if (Number.isFinite(milliseconds) && milliseconds >= 0) {
    output.longestReadMs = Math.max(output.longestReadMs, milliseconds);
  }
}

export function recordLargeAudioPcm(bytes: number): void {
  if (Number.isSafeInteger(bytes) && bytes >= 0) {
    output.peakPlaybackPcmBytes = Math.max(output.peakPlaybackPcmBytes, bytes);
  }
}

/** Page-lifetime aggregate. Returned copies cannot mutate the counters. */
export function getLargeAudioDiagnostics() {
  return {
    resources: {
      tracks: { ...resources.tracks },
      readers: { ...resources.readers },
      playbacks: { ...resources.playbacks },
      workerCalls: { ...resources.workerCalls },
    },
    output: { ...output },
  };
}
