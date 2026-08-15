/** Document-scoped ESM failures that require a real page reload to recover. */

type LazyFeatureName = 'pro-room' | 'room-session';

const FAILURE_MESSAGES: Readonly<Record<LazyFeatureName, string>> = {
  'pro-room': 'PRO_ROOM_RUNTIME_LOAD_FAILED_RELOAD_REQUIRED',
  'room-session': 'ROOM_SESSION_FEATURE_LOAD_FAILED_RELOAD_REQUIRED',
};

class LazyFeatureLoadError extends Error {
  override readonly name = 'LazyFeatureLoadError';

  constructor(
    readonly feature: LazyFeatureName,
    cause: unknown,
  ) {
    super(FAILURE_MESSAGES[feature], { cause });
  }
}

export function createLazyFeatureLoadError(feature: LazyFeatureName, cause: unknown): Error {
  return new LazyFeatureLoadError(feature, cause);
}

/** Recognize the terminal error even after a boundary wraps it as `cause`. */
export function isLazyFeatureLoadError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof LazyFeatureLoadError) return true;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
