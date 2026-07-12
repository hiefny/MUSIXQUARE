import { SharedEncodedAudioAsset } from './encoded-audio-asset.ts';
import {
  PeerRangeEncodedAudioSource,
  type PeerRangeEncodedAudioSourceOptions,
} from './peer-range-encoded-audio-source.ts';

export interface PeerRangeEncodedAudioAssetOptions extends Omit<
  PeerRangeEncodedAudioSourceOptions,
  'handleId'
> {
  /** Exact handle authorized by FILE_MEDIA_SOURCE_OFFER_V2. */
  readonly handleId: string;
}

/**
 * One offer-owned peer handle shared by at most two logical decoder readers.
 *
 * Lease close only aborts that lease's reads. The wrapped peer source remains
 * alive for the asset lifetime, so transport.closeHandle() is emitted exactly
 * once by final asset close instead of once per seek/recovery candidate.
 */
export class PeerRangeEncodedAudioAsset extends SharedEncodedAudioAsset {
  constructor(options: PeerRangeEncodedAudioAssetOptions) {
    super(new PeerRangeEncodedAudioSource(options));
  }
}
