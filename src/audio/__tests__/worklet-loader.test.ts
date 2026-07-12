import { describe, expect, it, vi } from 'vitest';

import { loadPcmRingWorklet } from '../worklet-loader.ts';

interface FakeContext {
  readonly audioWorklet?: {
    readonly addModule: ReturnType<typeof vi.fn<(url: string | URL) => Promise<void>>>;
  };
}

function createContext(load: (url: string | URL) => Promise<void> = async () => undefined): {
  readonly context: AudioContext;
  readonly addModule: ReturnType<typeof vi.fn<(url: string | URL) => Promise<void>>>;
} {
  const addModule = vi.fn(load);
  const context: FakeContext = { audioWorklet: { addModule } };
  return { context: context as AudioContext, addModule };
}

describe('loadPcmRingWorklet', () => {
  it('loads the bundled processor exactly once per context', async () => {
    const { context, addModule } = createContext();

    await loadPcmRingWorklet(context);
    await loadPcmRingWorklet(context);

    expect(addModule).toHaveBeenCalledOnce();
    const moduleUrl = addModule.mock.calls[0]?.[0];
    expect(moduleUrl).toBeInstanceOf(URL);
    expect(String(moduleUrl)).toMatch(/\/worklets\/pcm-ring-processor\.js$/);
  });

  it('joins concurrent calls to the same in-flight load', async () => {
    let resolveLoad: (() => void) | undefined;
    const loading = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    const { context, addModule } = createContext(() => loading);

    const first = loadPcmRingWorklet(context);
    const second = loadPcmRingWorklet(context);

    expect(second).toBe(first);
    expect(addModule).not.toHaveBeenCalled();

    resolveLoad?.();
    await Promise.all([first, second]);
    expect(addModule).toHaveBeenCalledOnce();
  });

  it('evicts a failed load so the same context can retry', async () => {
    const failure = new Error('module fetch failed');
    const { context, addModule } = createContext(
      vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined),
    );

    await expect(loadPcmRingWorklet(context)).rejects.toBe(failure);
    await expect(loadPcmRingWorklet(context)).resolves.toBeUndefined();

    expect(addModule).toHaveBeenCalledTimes(2);
  });

  it('loads independently for separate contexts', async () => {
    const first = createContext();
    const second = createContext();

    await Promise.all([loadPcmRingWorklet(first.context), loadPcmRingWorklet(second.context)]);

    expect(first.addModule).toHaveBeenCalledOnce();
    expect(second.addModule).toHaveBeenCalledOnce();
  });

  it('rejects unsupported contexts without attempting to own their lifecycle', async () => {
    const context = {} as AudioContext;

    await expect(loadPcmRingWorklet(context)).rejects.toThrow(
      'AudioWorklet is not supported by this browser.',
    );
  });
});
