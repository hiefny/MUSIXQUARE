/** Document-scoped ESM failures that require a real page reload to recover. */

import { isBrowserReportedOffline } from './browser-offline.ts';

type LazyFeatureName =
  'announcement' | 'connect' | 'pro-room' | 'room-session' | 'visualizer-spectrum';

const FAILURE_MESSAGES: Readonly<Record<LazyFeatureName, string>> = {
  announcement: 'ANNOUNCEMENT_LOAD_FAILED_RELOAD_REQUIRED',
  connect: 'CONNECT_RUNTIME_LOAD_FAILED_RELOAD_REQUIRED',
  'pro-room': 'PRO_ROOM_RUNTIME_LOAD_FAILED_RELOAD_REQUIRED',
  'room-session': 'ROOM_SESSION_FEATURE_LOAD_FAILED_RELOAD_REQUIRED',
  'visualizer-spectrum': 'VISUALIZER_SPECTRUM_LOAD_FAILED_RELOAD_REQUIRED',
};

class LazyFeatureLoadError extends Error {
  override readonly name = 'LazyFeatureLoadError';
  /**
   * Whether the browser reported no network when the feature failed. A chunk
   * that could not be fetched offline was not removed by an update, so its
   * guidance names the network. Each loader wraps its failure once and
   * latches it for the document, so this stays the record of that moment: a
   * failure from offline still names the network after the network returns,
   * and one from online keeps the update copy when a later trigger meets it
   * offline. A stale offline report gives a removed chunk the network copy
   * too; Refresh is offered either way.
   */
  readonly whileOffline = isBrowserReportedOffline();

  constructor(
    readonly feature: LazyFeatureName,
    cause: unknown,
  ) {
    super(FAILURE_MESSAGES[feature]);
    // Chromium 79 ignores ErrorOptions. Own the standard field explicitly so
    // failure diagnostics and recursive classification retain the root cause.
    Object.defineProperty(this, 'cause', {
      configurable: true,
      value: cause,
    });
  }
}

export function createLazyFeatureLoadError(feature: LazyFeatureName, cause: unknown): Error {
  return new LazyFeatureLoadError(feature, cause);
}

/** The terminal error, found even after a boundary wraps it as `cause`. */
function findLazyFeatureLoadError(error: unknown): LazyFeatureLoadError | null {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof LazyFeatureLoadError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Recognize the terminal error even after a boundary wraps it as `cause`. */
export function isLazyFeatureLoadError(error: unknown): boolean {
  return findLazyFeatureLoadError(error) !== null;
}

/**
 * Whether a feature failure happened while the browser reported no network,
 * so its guidance names the network instead of an update. A terminal error
 * answers with the record of the moment it failed. An error that no loader
 * wrapped is never latched, so the moment it is handled is the one to read.
 */
export function wasOfflineLazyFeatureFailure(error: unknown): boolean {
  return findLazyFeatureLoadError(error)?.whileOffline ?? isBrowserReportedOffline();
}
