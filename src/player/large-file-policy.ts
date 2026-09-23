/** Choose a local-file playback engine before preparing a track. */

import { LOCAL_LARGE_TRACK_WARNING_BYTES } from '../core/constants.ts';
import type { DecodeMemoryEstimate } from './decode-admission.ts';

const MIB = 1024 * 1024;

interface LargeFileThreshold {
  readonly decodedPcmBytes: number;
  readonly trackDecodeFootprintBytes: number;
}

const LARGE_FILE_THRESHOLDS: Record<DecodeMemoryEstimate['budget']['tier'], LargeFileThreshold> = {
  ios: { decodedPcmBytes: 192 * MIB, trackDecodeFootprintBytes: 320 * MIB },
  constrained: { decodedPcmBytes: 256 * MIB, trackDecodeFootprintBytes: 448 * MIB },
  standard: { decodedPcmBytes: 384 * MIB, trackDecodeFootprintBytes: 768 * MIB },
  'high-memory': { decodedPcmBytes: 512 * MIB, trackDecodeFootprintBytes: 1024 * MIB },
};

function isPositiveByteCount(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes > 0;
}

/**
 * These thresholds select an engine; they never reject a track. Keep selection
 * track-local: the total working set includes other tracks, transfers, and PCM
 * that WebKit has not reclaimed yet. Using it here would keep an ordinary song
 * on the large-file engine after returning from a large song.
 *
 * A metadata failure's 64x accounting estimate is deliberately not a selection
 * signal. With no usable duration, only a known large encoded file opts in.
 * Callers should pass Blob.size for that fallback rather than deriving it from
 * the admission ledger's implementation-specific accounting multipliers.
 */
export function shouldUseLargeFileEngine(
  estimate: DecodeMemoryEstimate,
  encodedBytes?: number,
): boolean {
  if (
    estimate.hasReliableMetadata &&
    isPositiveByteCount(estimate.estimatedPcmBytes) &&
    isPositiveByteCount(estimate.ownDecodeFootprintBytes)
  ) {
    const threshold = LARGE_FILE_THRESHOLDS[estimate.budget.tier];
    return (
      estimate.estimatedPcmBytes > threshold.decodedPcmBytes ||
      estimate.ownDecodeFootprintBytes > threshold.trackDecodeFootprintBytes
    );
  }

  return (
    typeof encodedBytes === 'number' &&
    isPositiveByteCount(encodedBytes) &&
    encodedBytes > LOCAL_LARGE_TRACK_WARNING_BYTES
  );
}
