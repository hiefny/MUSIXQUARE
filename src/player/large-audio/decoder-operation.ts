import type { CustomAudioDecoder } from 'mediabunny';

/** Keep the owner's serialized close reachable after a terminal codec failure. */
export async function runDecoderOperation(
  decoder: CustomAudioDecoder,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    // Mediabunny serializes custom methods on one promise chain. Rejecting it
    // also skips the queued close. Retire our worker immediately, then report
    // the original failure through the decoder error channel without poisoning
    // that chain. close() marks the decoder closed before its first await.
    const cleanup = Promise.resolve(decoder.close()).catch(() => undefined);
    decoder.onError(error);
    await cleanup;
  }
}
