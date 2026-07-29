/**
 * Playback-only failures. Authentication, forged control frames, immutable
 * room-scope violations, and physical transport corruption are deliberately
 * absent: they are classified before this boundary by TransportSession.
 */
export type FilePlaybackFailureKind =
  | 'delivery-transient'
  | 'delivery-exhausted'
  | 'media-integrity-failed'
  | 'decoder-unsupported-before-adoption-with-legacy-ready'
  | 'decoder-unsupported-after-adoption'
  | 'decoder-failed'
  | 'renderer-failed'
  | 'sequence-gap'
  | 'state-conflict'
  | 'stale-effect'
  | 'stale-local-epoch';

export type FilePlaybackRecoveryAction =
  | 'retry-delivery'
  | 'request-alternate-delivery'
  | 'retire-media'
  | 'fallback-legacy-before-adoption'
  | 'reset-renderer'
  | 'request-snapshot'
  | 'discard-stale-effect';

export interface FilePlaybackFailureDisposition {
  readonly recovery: FilePlaybackRecoveryAction;
}

function disposition(recovery: FilePlaybackRecoveryAction): FilePlaybackFailureDisposition {
  return Object.freeze({ recovery });
}

/**
 * This result has intentionally no connection/transport field. Playback code
 * cannot request, imply, or directly perform physical room teardown.
 */
export function classifyFilePlaybackFailure(
  kind: FilePlaybackFailureKind,
): FilePlaybackFailureDisposition {
  switch (kind) {
    case 'delivery-transient':
      return disposition('retry-delivery');
    case 'delivery-exhausted':
      return disposition('request-alternate-delivery');
    case 'media-integrity-failed':
    case 'decoder-unsupported-after-adoption':
    case 'decoder-failed':
      return disposition('retire-media');
    case 'decoder-unsupported-before-adoption-with-legacy-ready':
      return disposition('fallback-legacy-before-adoption');
    case 'renderer-failed':
      return disposition('reset-renderer');
    case 'sequence-gap':
    case 'state-conflict':
      return disposition('request-snapshot');
    case 'stale-effect':
    case 'stale-local-epoch':
      return disposition('discard-stale-effect');
  }
}
