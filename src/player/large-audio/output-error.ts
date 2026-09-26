/** Native output scheduling failed; this does not establish corrupt media. */
class LargeAudioOutputError extends Error {
  constructor(cause: unknown) {
    super('Large-audio output scheduling failed', { cause });
    this.name = 'LargeAudioOutputError';
  }
}

/** Wrap native output calls only, never PCM validation or decoder iteration. */
export function withLargeAudioOutput<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (isLargeAudioOutputError(error)) throw error;
    throw new LargeAudioOutputError(error);
  }
}

export function isLargeAudioOutputError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof LargeAudioOutputError) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}
