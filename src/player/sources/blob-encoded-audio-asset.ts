import { SharedEncodedAudioAsset } from './encoded-audio-asset.ts';
import {
  BlobEncodedAudioSource,
  type BlobEncodedAudioSourceOptions,
} from './blob-encoded-audio-source.ts';

/**
 * Shareable asset over one exact Blob/File object.
 *
 * Construction and lease acquisition retain the Blob by reference; no media
 * body is copied or persisted. Individual bounded readAt() calls continue to
 * use Blob.slice() through BlobEncodedAudioSource.
 */
export class BlobEncodedAudioAsset extends SharedEncodedAudioAsset {
  constructor(blob: Blob, options: BlobEncodedAudioSourceOptions = {}) {
    super(new BlobEncodedAudioSource(blob, options));
  }
}
