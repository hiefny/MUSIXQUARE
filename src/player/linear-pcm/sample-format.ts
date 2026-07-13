/** Linear PCM encodings currently supported by the bounded decoder. */
export type LinearPcmEncoding =
  | 'pcm-u8'
  | 'pcm-s8'
  | 'pcm-s16le'
  | 'pcm-s16be'
  | 'pcm-s24le'
  | 'pcm-s24be'
  | 'pcm-s32le'
  | 'pcm-s32be'
  | 'float32le'
  | 'float32be'
  | 'float64le'
  | 'float64be';

export interface LinearPcmSampleLayout {
  readonly channels: number;
  readonly encoding: LinearPcmEncoding;
  readonly containerBitsPerSample: 8 | 16 | 24 | 32 | 64;
  readonly validBitsPerSample: number;
  readonly blockAlign: number;
}

export interface DecodedLinearPcm {
  readonly channels: readonly Float32Array[];
  readonly frames: number;
}

export type LinearPcmDecodeErrorCode = 'nonzero-unused-bits';

/** Encoded sample bytes contradict an otherwise valid linear-PCM layout. */
export class LinearPcmDecodeError extends Error {
  readonly code: LinearPcmDecodeErrorCode;

  constructor(code: LinearPcmDecodeErrorCode, message: string) {
    super(message);
    this.name = 'LinearPcmDecodeError';
    this.code = code;
  }
}
