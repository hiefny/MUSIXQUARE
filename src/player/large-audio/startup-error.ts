/** A decoder could not be acquired or started; this says nothing about the file. */
class AudioDecoderStartupError extends Error {
  constructor(cause: unknown) {
    super('Audio decoder startup failed', { cause });
    this.name = 'AudioDecoderStartupError';
  }
}

/** Mark only module acquisition / worker bootstrap, never media decoding. */
export async function withAudioDecoderStartup<T>(start: () => Promise<T>): Promise<T> {
  try {
    return await start();
  } catch (error) {
    if (isAudioDecoderStartupError(error)) throw error;
    throw new AudioDecoderStartupError(error);
  }
}

export function isAudioDecoderStartupError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof AudioDecoderStartupError) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}
