import {
  releaseFilePlaybackResource,
  retainFilePlaybackResource,
  type LargeAudioPlayback,
  type LargeAudioTrack,
  type LargeFileSource,
} from './file-playback-resource.ts';

class LargeFileDecoderStartError extends Error {
  constructor(cause: unknown) {
    super('Large-file decoder failed during start', { cause });
    this.name = 'LargeFileDecoderStartError';
  }
}

/** A reported decoder rejection, distinct from an audio-route/start exception. */
export function isLargeFileDecoderStartError(error: unknown): boolean {
  return error instanceof LargeFileDecoderStartError;
}

/** Adapt a bounded decoder to the same one-shot output ownership as a native source. */
export function createLargeFileSource(
  track: LargeAudioTrack,
  context: AudioContext,
  destination: AudioNode,
  onerror: (error: unknown) => void,
): LargeFileSource {
  let playback: LargeAudioPlayback | null = null;
  let stopped = false;
  let started = false;
  let failed = false;
  let terminal = false;
  let starting = false;
  let failure: unknown;
  retainFilePlaybackResource(track);

  const source: LargeFileSource = {
    kind: 'large-audio-source',
    buffer: track,
    onended: null,
    get ended() {
      return stopped || terminal || playback?.ended === true;
    },
    start(when, offset) {
      if (started || stopped) throw new Error('Large-file source is no longer startable');
      started = true;
      starting = true;
      try {
        playback = track.createPlayback({
          context,
          destination,
          // Native AudioBufferSourceNode treats zero/past times as "now". The
          // bounded scheduler needs that same start expressed as an absolute
          // AudioContext time, or it drops the context's entire elapsed age.
          when: Math.max(context.currentTime, when),
          offset,
          onended() {
            if (stopped || terminal) return;
            terminal = true;
            source.onended?.(new Event('ended'));
          },
          onerror(error) {
            if (stopped || terminal) return;
            terminal = true;
            failed = true;
            failure = error;
            if (!starting) onerror(error);
          },
        });
      } finally {
        starting = false;
      }
      if (failed) throw new LargeFileDecoderStartError(failure);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        playback?.stop();
      } finally {
        releaseFilePlaybackResource(track);
      }
    },
    disconnect() {
      playback?.disconnect();
    },
  };
  return source;
}
