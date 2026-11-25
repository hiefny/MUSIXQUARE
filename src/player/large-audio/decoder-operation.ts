import type { CustomAudioDecoder } from 'mediabunny';

/** Retire the worker at a terminal codec failure and report that failure once. */
export async function runDecoderOperation(
  decoder: CustomAudioDecoder,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    // Mediabunny serializes custom methods on one promise chain. Since 1.66 a
    // rejected call no longer skips the calls queued after it, close included.
    // Retire our worker now rather than when the sink closes this decoder,
    // then report the original failure once, through the decoder error
    // channel. close() marks the decoder closed before its first await.
    const cleanup = Promise.resolve(decoder.close()).catch(() => undefined);
    decoder.onError(error);
    await cleanup;
  }
}
