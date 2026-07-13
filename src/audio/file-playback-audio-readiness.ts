import { delay } from '../core/timers.ts';
import { getAudioContext, getFilePlaybackDestination, initAudio } from './engine.ts';

const DEFAULT_RESUME_SETTLE_MS = 1_000;

export interface FilePlaybackProductAudioGraph {
  readonly audioContext: AudioContext;
  readonly destination: AudioNode;
}

interface FilePlaybackProductAudioReadinessRuntime {
  readonly getAudioContext: () => AudioContext;
  readonly initAudio: () => Promise<void>;
  readonly getDestination: () => AudioNode | null;
  readonly waitForResumeSettlement: (resume: Promise<void>) => Promise<void>;
}

export interface FilePlaybackProductAudioReadinessOptions {
  readonly runtimeForTests?: Partial<FilePlaybackProductAudioReadinessRuntime>;
}

function productionRuntime(): FilePlaybackProductAudioReadinessRuntime {
  return Object.freeze({
    getAudioContext,
    initAudio,
    getDestination: getFilePlaybackDestination,
    waitForResumeSettlement: (resume: Promise<void>) =>
      Promise.race([resume, delay(DEFAULT_RESUME_SETTLE_MS)]),
  });
}

function audioNodeContext(node: AudioNode): BaseAudioContext | null {
  try {
    return node.context ?? null;
  } catch {
    return null;
  }
}

/**
 * Document-lifetime readiness for the shared product audio graph.
 *
 * `primeFromGesture()` deliberately calls `AudioContext.resume()` before it
 * creates any promise continuation. Each genuine setup gesture therefore gets
 * a fresh WebKit resume attempt even when an older graph initialization is
 * still pending. Room and connection owners consume only the immutable graph
 * result; they never own or close the document AudioContext.
 */
export class FilePlaybackProductAudioReadiness {
  readonly #runtime: FilePlaybackProductAudioReadinessRuntime;
  #latest: Promise<Readonly<FilePlaybackProductAudioGraph>> | null = null;

  constructor(options: FilePlaybackProductAudioReadinessOptions = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('File playback audio readiness options are invalid');
    }
    const production = productionRuntime();
    const overrides = options.runtimeForTests ?? {};
    const runtime = {
      getAudioContext: overrides.getAudioContext ?? production.getAudioContext,
      initAudio: overrides.initAudio ?? production.initAudio,
      getDestination: overrides.getDestination ?? production.getDestination,
      waitForResumeSettlement:
        overrides.waitForResumeSettlement ?? production.waitForResumeSettlement,
    };
    if (Object.values(runtime).some((value) => typeof value !== 'function')) {
      throw new TypeError('File playback audio readiness runtime is invalid');
    }
    this.#runtime = Object.freeze(runtime);
  }

  primeFromGesture(): Promise<Readonly<FilePlaybackProductAudioGraph>> {
    let audioContext: AudioContext;
    let resume: Promise<void>;
    let initialize: Promise<void>;
    try {
      audioContext = this.#runtime.getAudioContext();
      // Do not move this call behind an await or microtask. Safari requires it
      // to execute in the original click/keydown activation stack.
      resume =
        audioContext.state === 'running'
          ? Promise.resolve()
          : Promise.resolve(audioContext.resume());
      initialize = Promise.resolve(this.#runtime.initAudio());
    } catch (cause) {
      const rejected = Promise.reject(
        cause instanceof Error
          ? cause
          : new Error('File playback audio activation failed', { cause }),
      );
      void rejected.catch(() => undefined);
      this.#latest = rejected;
      return rejected;
    }

    const candidate = Promise.allSettled([
      initialize,
      this.#runtime.waitForResumeSettlement(resume),
    ]).then((settlements) => {
      const initialization = settlements[0];
      if (initialization?.status === 'rejected') throw initialization.reason;
      if (audioContext.state !== 'running') {
        throw new Error('File playback AudioContext is not running');
      }
      const destination = this.#runtime.getDestination();
      if (!destination || audioNodeContext(destination) !== audioContext) {
        throw new Error('File playback audio destination is unavailable or foreign');
      }
      return Object.freeze({ audioContext, destination });
    });
    void candidate.catch(() => undefined);
    this.#latest = candidate;
    return candidate;
  }

  current(): Promise<Readonly<FilePlaybackProductAudioGraph>> {
    return (
      this.#latest ??
      Promise.reject(new Error('File playback audio was not primed from a user gesture'))
    );
  }
}

const productAudioReadiness = new FilePlaybackProductAudioReadiness();

export function primeFilePlaybackProductAudioFromGesture(): Promise<
  Readonly<FilePlaybackProductAudioGraph>
> {
  return productAudioReadiness.primeFromGesture();
}

export function getPrimedFilePlaybackProductAudio(): Promise<
  Readonly<FilePlaybackProductAudioGraph>
> {
  return productAudioReadiness.current();
}
