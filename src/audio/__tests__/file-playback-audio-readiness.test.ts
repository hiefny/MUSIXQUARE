import { describe, expect, it, vi } from 'vitest';
import { FilePlaybackProductAudioReadiness } from '../file-playback-audio-readiness.ts';

interface Harness {
  readonly context: AudioContext;
  readonly destination: AudioNode;
  readonly resume: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly initAudio: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly order: string[];
  readonly readiness: FilePlaybackProductAudioReadiness;
}

function harness(state: AudioContextState = 'suspended'): Harness {
  const order: string[] = [];
  const context = {
    state,
    resume: vi.fn(() => {
      order.push('resume');
      return Promise.resolve();
    }),
  } as unknown as AudioContext;
  const destination = { context } as unknown as AudioNode;
  const initAudio = vi.fn(() => {
    order.push('init');
    return Promise.resolve();
  });
  const readiness = new FilePlaybackProductAudioReadiness({
    runtimeForTests: {
      getAudioContext: () => {
        order.push('context');
        return context;
      },
      initAudio,
      getDestination: () => destination,
      waitForResumeSettlement: async (resume) => {
        order.push('wait');
        await resume;
      },
    },
  });
  return {
    context,
    destination,
    resume: context.resume as Harness['resume'],
    initAudio,
    order,
    readiness,
  };
}

describe('FilePlaybackProductAudioReadiness', () => {
  it('starts context resume and graph initialization synchronously in the gesture stack', async () => {
    const h = harness();

    const task = h.readiness.primeFromGesture();

    expect(h.order.slice(0, 3)).toEqual(['context', 'resume', 'init']);
    Object.defineProperty(h.context, 'state', { value: 'running', configurable: true });
    await expect(task).resolves.toEqual({
      audioContext: h.context,
      destination: h.destination,
    });
    await expect(h.readiness.current()).resolves.toEqual({
      audioContext: h.context,
      destination: h.destination,
    });
  });

  it('rejects readiness when the resume settlement leaves the context suspended', async () => {
    const h = harness();

    await expect(h.readiness.primeFromGesture()).rejects.toThrow(
      'File playback AudioContext is not running',
    );
  });

  it('issues a fresh resume attempt for a later genuine gesture while init is pending', async () => {
    let resolveInit!: () => void;
    const pendingInit = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });
    const h = harness();
    h.initAudio.mockReturnValue(pendingInit);

    const first = h.readiness.primeFromGesture();
    const second = h.readiness.primeFromGesture();

    expect(h.resume).toHaveBeenCalledTimes(2);
    Object.defineProperty(h.context, 'state', { value: 'running', configurable: true });
    resolveInit();
    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
    await expect(h.readiness.current()).resolves.toBeDefined();
  });

  it('rejects a destination from a different AudioContext', async () => {
    const h = harness('running');
    const foreign = {} as AudioContext;
    Object.defineProperty(h.destination, 'context', { value: foreign, configurable: true });

    await expect(h.readiness.primeFromGesture()).rejects.toThrow(
      'File playback audio destination is unavailable or foreign',
    );
  });

  it('does not synthesize a readiness before a user gesture primes it', async () => {
    const h = harness();

    await expect(h.readiness.current()).rejects.toThrow(
      'File playback audio was not primed from a user gesture',
    );
    expect(h.resume).not.toHaveBeenCalled();
  });
});
