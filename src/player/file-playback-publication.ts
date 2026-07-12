import type { FilePlaybackSourceSnapshot } from './file-playback-source.ts';
import type { FilePlaybackManager, FilePlaybackPublication } from './file-playback-manager.ts';
import type { BlobFilePlaybackSourceResult } from './file-playback-source-factory.ts';

export type ManagedFilePlaybackUnpublishedReason = 'aborted' | 'superseded' | 'duplicates-active';

export type ManagedFilePlaybackPublicationOutcome =
  | {
      readonly published: true;
      readonly backend: BlobFilePlaybackSourceResult['backend'];
      readonly sourceIdentity: string;
      readonly snapshot: FilePlaybackSourceSnapshot;
    }
  | {
      readonly published: false;
      readonly backend: BlobFilePlaybackSourceResult['backend'];
      readonly sourceIdentity: string;
      readonly reason: ManagedFilePlaybackUnpublishedReason;
    };

export interface ManagedFilePlaybackPublicationOptions {
  /** The exact factory result owned by this publication attempt. */
  readonly result: BlobFilePlaybackSourceResult;
  readonly manager: FilePlaybackManager;
  readonly destination: AudioNode;
  /** True only while this load is still the authoritative queue occurrence. */
  readonly isCurrent: () => boolean;
  /** Cancels a pending activation without turning ordinary supersession into an error. */
  readonly signal?: AbortSignal;
  /** Publish only the exact decoded buffer carried by an AudioBuffer factory result. */
  readonly publishResident: (audioBuffer: AudioBuffer) => void;
  /** Identity-guarded cleanup; a same-queue-item successor must remain untouched. */
  readonly clearResidentIfOwned: (audioBuffer: AudioBuffer) => void;
}

type ActivationSettlement =
  | { readonly kind: 'publication'; readonly publication: FilePlaybackPublication }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'aborted' };

type CapturedError =
  | { readonly present: false }
  | { readonly present: true; readonly error: unknown };

const NO_ERROR: CapturedError = Object.freeze({ present: false });

function capturedError(error: unknown): CapturedError {
  return { present: true, error };
}

function invalidOptions(message: string): TypeError {
  return new TypeError(`Managed file playback publication ${message}`);
}

function assertOptions(options: ManagedFilePlaybackPublicationOptions): void {
  if (!options.result?.source) throw invalidOptions('requires a factory result');
  if (!options.manager) throw invalidOptions('requires a manager');
  if (!options.destination) throw invalidOptions('requires an audio destination');
  if (typeof options.isCurrent !== 'function') {
    throw invalidOptions('requires an authority callback');
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw invalidOptions('received an invalid AbortSignal');
  }
  if (
    typeof options.publishResident !== 'function' ||
    typeof options.clearResidentIfOwned !== 'function'
  ) {
    throw invalidOptions('requires resident AudioBuffer hooks');
  }
}

function unpublishedOutcome(
  result: BlobFilePlaybackSourceResult,
  reason: ManagedFilePlaybackUnpublishedReason,
): ManagedFilePlaybackPublicationOutcome {
  return Object.freeze({
    published: false,
    backend: result.backend,
    sourceIdentity: result.sourceIdentity,
    reason,
  });
}

function publishedOutcome(
  result: BlobFilePlaybackSourceResult,
  snapshot: FilePlaybackSourceSnapshot,
): ManagedFilePlaybackPublicationOutcome {
  return Object.freeze({
    published: true,
    backend: result.backend,
    sourceIdentity: result.sourceIdentity,
    snapshot,
  });
}

async function settleActivation(
  activation: Promise<FilePlaybackPublication>,
  signal: AbortSignal | undefined,
): Promise<ActivationSettlement> {
  const settled = activation.then<ActivationSettlement, ActivationSettlement>(
    (publication) => ({ kind: 'publication', publication }),
    (error: unknown) => ({ kind: 'error', error }),
  );
  if (!signal) return settled;
  if (signal.aborted) return { kind: 'aborted' };

  let removeAbortListener = (): void => undefined;
  const aborted = new Promise<ActivationSettlement>((resolve) => {
    const onAbort = (): void => resolve({ kind: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([settled, aborted]);
  } finally {
    removeAbortListener();
  }
}

/**
 * Atomically transfers one factory result into manager and resident ownership.
 *
 * The decoder construction lease stays live until both native-source activation
 * and (for ordinary codecs) exact AudioBuffer publication have succeeded. Every
 * rollback is object-identity based, so a newer source with the same queue item
 * ID cannot be retired or removed from the resident slot by a stale attempt.
 */
export async function publishManagedFilePlaybackSource(
  options: ManagedFilePlaybackPublicationOptions,
): Promise<ManagedFilePlaybackPublicationOutcome> {
  assertOptions(options);
  const { result, manager, destination, signal } = options;
  let leaseOwned = true;
  let retireOwned = true;
  let residentMayBeOwned = false;

  const releaseLeaseOnce = (): void => {
    if (!leaseOwned) return;
    leaseOwned = false;
    result.releaseConstructionLease();
  };

  const cleanup = (primaryError: CapturedError = NO_ERROR): void => {
    let cleanupError: CapturedError = NO_ERROR;
    if (retireOwned) {
      retireOwned = false;
      try {
        // FilePlaybackManager detaches exact ownership synchronously before its
        // first await. Destruction may be slow or permanently stuck on a
        // platform native object, so observe its eventual rejection without
        // blocking resident cleanup, lease release, or an abort outcome.
        const retirement = manager.retire(result.source);
        void Promise.resolve(retirement).catch(() => undefined);
      } catch (error) {
        cleanupError = capturedError(error);
      }
    }
    if (residentMayBeOwned && result.backend === 'audio-buffer') {
      residentMayBeOwned = false;
      try {
        options.clearResidentIfOwned(result.audioBuffer);
      } catch (error) {
        if (!cleanupError.present) cleanupError = capturedError(error);
      }
    }
    try {
      releaseLeaseOnce();
    } catch (error) {
      if (!cleanupError.present) cleanupError = capturedError(error);
    }
    if (primaryError.present) throw primaryError.error;
    if (cleanupError.present) throw cleanupError.error;
  };

  const authorityIsCurrent = (): boolean => {
    if (signal?.aborted) return false;
    const current = options.isCurrent();
    // isCurrent() is client code and may synchronously abort/supersede this
    // attempt. Re-read the signal before allowing resident publication.
    return current && !signal?.aborted;
  };

  try {
    if (!authorityIsCurrent()) {
      cleanup();
      return unpublishedOutcome(result, signal?.aborted ? 'aborted' : 'superseded');
    }
  } catch (error) {
    cleanup(capturedError(error));
    throw error;
  }

  let activation: Promise<FilePlaybackPublication>;
  try {
    activation = manager.activate(result.source, destination, authorityIsCurrent);
  } catch (error) {
    cleanup(capturedError(error));
    throw error;
  }

  const settlement = await settleActivation(activation, signal);
  if (settlement.kind === 'aborted') {
    cleanup();
    return unpublishedOutcome(result, 'aborted');
  }
  if (settlement.kind === 'error') {
    cleanup(capturedError(settlement.error));
    throw settlement.error;
  }
  if (!settlement.publication.published) {
    cleanup();
    return unpublishedOutcome(result, settlement.publication.reason);
  }

  try {
    if (!authorityIsCurrent()) {
      cleanup();
      return unpublishedOutcome(result, signal?.aborted ? 'aborted' : 'superseded');
    }

    if (result.backend === 'audio-buffer') {
      // Mark before calling client code: a hook that publishes and then throws
      // must still be rolled back through its exact-buffer ownership guard.
      residentMayBeOwned = true;
      options.publishResident(result.audioBuffer);
    }

    if (!authorityIsCurrent()) {
      cleanup();
      return unpublishedOutcome(result, signal?.aborted ? 'aborted' : 'superseded');
    }

    releaseLeaseOnce();

    // Hooks are synchronous but may be re-entrant. A final authority check
    // closes that seam without inserting another asynchronous publication gap.
    if (!authorityIsCurrent()) {
      cleanup();
      return unpublishedOutcome(result, signal?.aborted ? 'aborted' : 'superseded');
    }

    retireOwned = false;
    return publishedOutcome(result, settlement.publication.snapshot);
  } catch (error) {
    cleanup(capturedError(error));
    throw error;
  }
}
