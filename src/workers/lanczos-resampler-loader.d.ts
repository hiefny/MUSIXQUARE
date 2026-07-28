declare module 'lanczos-resampler/loader.js' {
  export class ResampleOutcome {
    readonly numRead: number;
    readonly numWritten: number;
    free(): void;
  }

  export class ChunkedResampler {
    constructor(inputSampleRate: number, outputSampleRate: number);
    readonly inputSampleRate: number;
    outputSampleRate: number;
    maxNumOutputFrames(numInputFrames: number): number;
    resample(chunk: Float32Array, output: Float32Array): ResampleOutcome;
    reset(): void;
    free(): void;
  }

  export function initWithBase64(): Promise<void>;
}
