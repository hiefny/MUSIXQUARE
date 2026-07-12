import { getFilePlaybackDestination } from '../audio/engine.ts';
import { log } from '../core/log.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  AudioBufferPlaybackSource,
  type AudioBufferPlaybackSourceOptions,
} from './backends/audio-buffer-playback-source.ts';
import { getFilePlaybackClock, type FilePlaybackClockBindings } from './file-playback-clock.ts';
import type { FilePlaybackManager } from './file-playback-manager.ts';
import type { FilePlaybackSource } from './file-playback-source.ts';
import {
  publishManagedFilePlaybackSource,
  type ManagedFilePlaybackPublicationOutcome,
} from './file-playback-publication.ts';
import { getFilePlaybackManager } from './file-playback-runtime.ts';
import type { AudioBufferFilePlaybackSourceResult } from './file-playback-source-factory.ts';
import { getBlobObjectIdentity } from './sources/blob-encoded-audio-source.ts';

export interface AudioBufferShadowRuntime {
  readonly manager: FilePlaybackManager;
  readonly getDestination: () => AudioNode | null;
  readonly bindClock: (audioContext: AudioContext) => FilePlaybackClockBindings;
  readonly createSource: (options: AudioBufferPlaybackSourceOptions) => AudioBufferPlaybackSource;
  readonly publishSource: typeof publishManagedFilePlaybackSource;
  readonly onInfrastructureFailure: (error: unknown) => void;
}

export interface PublishAudioBufferShadowOptions {
  readonly queueItemId: QueueItemId;
  readonly blob: Blob;
  readonly audioBuffer: AudioBuffer;
  readonly audioContext: AudioContext;
  /** The decode-admission reservation paired with this exact AudioBuffer. */
  readonly releaseConstructionLease: () => void;
  /** True only while this load still owns the selected queue occurrence. */
  readonly isCurrent: () => boolean;
  /** Existing product publication. This remains the audible-control authority. */
  readonly publishResident: (audioBuffer: AudioBuffer) => void;
  /** Must clear only the same AudioBuffer, never a successor's resident buffer. */
  readonly clearResidentIfOwned: (audioBuffer: AudioBuffer) => void;
  readonly runtime?: Partial<AudioBufferShadowRuntime>;
}

export type AudioBufferShadowPublicationOutcome =
  | {
      readonly status: 'managed-shadow';
      readonly source: AudioBufferPlaybackSource;
      readonly publication: Extract<ManagedFilePlaybackPublicationOutcome, { published: true }>;
    }
  | {
      readonly status: 'legacy-fallback';
      readonly source: null;
      readonly infrastructureError: unknown;
    }
  | {
      readonly status: 'unpublished';
      readonly source: null;
      readonly reason: 'superseded' | 'aborted' | 'duplicates-active';
    };

export interface RetireActiveManagedSourceOptions {
  readonly isCurrent: () => boolean;
  readonly runtime?: Pick<Partial<AudioBufferShadowRuntime>, 'manager' | 'onInfrastructureFailure'>;
}

export interface WithdrawAudioBufferShadowOptions {
  readonly outcome: AudioBufferShadowPublicationOutcome;
  readonly audioBuffer: AudioBuffer;
  readonly clearResidentIfOwned: (audioBuffer: AudioBuffer) => void;
  readonly runtime?: Pick<Partial<AudioBufferShadowRuntime>, 'manager' | 'onInfrastructureFailure'>;
}

const defaultRuntime: AudioBufferShadowRuntime = {
  manager: getFilePlaybackManager(),
  getDestination: () => getFilePlaybackDestination(),
  bindClock: (audioContext) => getFilePlaybackClock().bindAudioContext(audioContext),
  createSource: (options) => new AudioBufferPlaybackSource(options),
  publishSource: publishManagedFilePlaybackSource,
  onInfrastructureFailure: (error) => {
    log.warn('[FilePlayback] Managed AudioBuffer shadow unavailable; using legacy playback', error);
  },
};

function resolveRuntime(runtime?: Partial<AudioBufferShadowRuntime>): AudioBufferShadowRuntime {
  return { ...defaultRuntime, ...runtime };
}

function oneShotRelease(release: () => void): () => void {
  let ownedRelease: (() => void) | null = release;
  return () => {
    const current = ownedRelease;
    if (current === null) return;
    // Claim before invoking client code: even a throwing cleanup is one-shot.
    ownedRelease = null;
    current();
  };
}

function reportInfrastructureFailure(runtime: AudioBufferShadowRuntime, error: unknown): void {
  try {
    runtime.onInfrastructureFailure(error);
  } catch {
    // Diagnostics must never replace the legacy playback fallback.
  }
}

function retireWithoutMasking(
  runtime: AudioBufferShadowRuntime,
  source: FilePlaybackSource | null,
): void {
  if (!source) return;
  try {
    // FilePlaybackManager detaches exact ownership synchronously before the
    // returned Promise begins native destruction. Do not make a new load, a
    // stale rollback, or its decode lease depend on that native Promise ever
    // settling. The attached rejection observer also prevents a late platform
    // cleanup failure from becoming an unhandled rejection.
    const retirement = runtime.manager.retire(source);
    void Promise.resolve(retirement).catch((error: unknown) => {
      reportInfrastructureFailure(runtime, error);
    });
  } catch (error) {
    reportInfrastructureFailure(runtime, error);
  }
}

function unpublishedReason(
  publication: Extract<ManagedFilePlaybackPublicationOutcome, { published: false }>,
): AudioBufferShadowPublicationOutcome {
  return Object.freeze({
    status: 'unpublished',
    source: null,
    reason: publication.reason,
  });
}

/**
 * Publish an ordinary decoded buffer into the new manager as a silent shadow.
 *
 * Manager activation only prepares and connects AudioBufferPlaybackSource; it
 * never creates or starts an AudioBufferSourceNode. The existing resident
 * AudioBuffer and transport therefore remain the sole audible authority until
 * the later atomic control cutover.
 */
export async function publishAudioBufferShadow(
  options: PublishAudioBufferShadowOptions,
): Promise<AudioBufferShadowPublicationOutcome> {
  const runtime = resolveRuntime(options.runtime);
  const releaseOnce = oneShotRelease(options.releaseConstructionLease);
  let source: AudioBufferPlaybackSource | null = null;

  const fallback = (infrastructureError: unknown): AudioBufferShadowPublicationOutcome => {
    reportInfrastructureFailure(runtime, infrastructureError);
    let currentBeforePublication: boolean;
    try {
      currentBeforePublication = options.isCurrent();
    } catch (error) {
      releaseOnce();
      throw error;
    }
    if (!currentBeforePublication) {
      releaseOnce();
      return Object.freeze({ status: 'unpublished', source: null, reason: 'superseded' });
    }

    let residentMayBeOwned = false;
    let fallbackAccepted = false;
    try {
      // Mark before calling client code: it may mutate and then throw.
      residentMayBeOwned = true;
      options.publishResident(options.audioBuffer);
      if (!options.isCurrent()) {
        options.clearResidentIfOwned(options.audioBuffer);
        residentMayBeOwned = false;
        return Object.freeze({ status: 'unpublished', source: null, reason: 'superseded' });
      }
      fallbackAccepted = true;
      return Object.freeze({
        status: 'legacy-fallback',
        source: null,
        infrastructureError,
      });
    } finally {
      // A publishing callback that throws after mutation is rolled back by its
      // exact-buffer guard; a successor using another object is untouched.
      try {
        if (residentMayBeOwned) {
          let currentAfterPublication = false;
          try {
            currentAfterPublication = options.isCurrent();
          } catch {
            // An authority callback that can no longer answer is not allowed to
            // leave its resident buffer published.
          }
          if (!fallbackAccepted || !currentAfterPublication) {
            options.clearResidentIfOwned(options.audioBuffer);
          }
        }
      } finally {
        releaseOnce();
      }
    }
  };

  try {
    if (!options.isCurrent()) {
      releaseOnce();
      return Object.freeze({ status: 'unpublished', source: null, reason: 'superseded' });
    }
  } catch (error) {
    releaseOnce();
    throw error;
  }

  let destination: AudioNode | null;
  try {
    destination = runtime.getDestination();
  } catch (error) {
    return fallback(error);
  }
  if (!destination) return fallback(new Error('FILE_PLAYBACK_DESTINATION_UNAVAILABLE'));

  try {
    const clock = runtime.bindClock(options.audioContext);
    source = runtime.createSource({
      queueItemId: options.queueItemId,
      audioBuffer: options.audioBuffer,
      audioContext: options.audioContext,
      ...clock,
    });

    const result: AudioBufferFilePlaybackSourceResult = Object.freeze({
      backend: 'audio-buffer',
      source,
      sourceIdentity: getBlobObjectIdentity(options.blob),
      audioBuffer: options.audioBuffer,
      // The lower-level publication primitive may clean up before this wrapper
      // has selected its legacy fallback. Keep the real lease here until the
      // wrapper has either published the exact resident buffer or definitively
      // chosen an unpublished outcome.
      releaseConstructionLease: () => undefined,
      flacMetadata: null,
    });
    const publication = await runtime.publishSource({
      result,
      manager: runtime.manager,
      destination,
      isCurrent: options.isCurrent,
      publishResident: options.publishResident,
      clearResidentIfOwned: options.clearResidentIfOwned,
    });
    if (!publication.published) {
      releaseOnce();
      return unpublishedReason(publication);
    }
    releaseOnce();
    return Object.freeze({ status: 'managed-shadow', source, publication });
  } catch (error) {
    // The publication primitive normally performs both operations itself. The
    // repeats here are identity-safe and one-shot, covering failures in custom
    // runtime seams or source construction before ownership transfer.
    retireWithoutMasking(runtime, source);
    try {
      if (!options.isCurrent()) {
        releaseOnce();
        return Object.freeze({ status: 'unpublished', source: null, reason: 'superseded' });
      }
    } catch (authorityError) {
      releaseOnce();
      throw authorityError;
    }
    return fallback(error);
  }
}

/**
 * Retire the exact active manager object before admitting another full decode.
 * A concurrently published successor (even with the same queueItemId) is not
 * addressed, and standby ownership is never inspected or modified.
 */
export async function retireActiveManagedSourceBeforeDecode(
  options: RetireActiveManagedSourceOptions,
): Promise<boolean> {
  const runtime = resolveRuntime(options.runtime);
  if (!options.isCurrent()) return false;

  let previous: ReturnType<FilePlaybackManager['activeSource']>;
  try {
    previous = runtime.manager.activeSource();
  } catch (error) {
    reportInfrastructureFailure(runtime, error);
    return options.isCurrent();
  }

  if (previous) {
    retireWithoutMasking(runtime, previous);
  }
  return options.isCurrent();
}

/** Withdraw one completed shadow publication after its caller loses authority. */
export async function withdrawAudioBufferShadow(
  options: WithdrawAudioBufferShadowOptions,
): Promise<void> {
  const runtime = resolveRuntime(options.runtime);
  if (options.outcome.status === 'managed-shadow') {
    retireWithoutMasking(runtime, options.outcome.source);
  }
  options.clearResidentIfOwned(options.audioBuffer);
}
