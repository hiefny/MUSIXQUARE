/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../core/events.ts', () => {
  type TestHandler = (...args: unknown[]) => unknown;
  const handlers = new Map<string, TestHandler[]>();
  const bus = {
    on: vi.fn((event: string, handler: TestHandler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return () => {
        const fns = handlers.get(event);
        if (!fns) return;
        const idx = fns.indexOf(handler);
        if (idx >= 0) fns.splice(idx, 1);
      };
    }),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      const fns = handlers.get(event) || [];
      fns.forEach((fn) => fn(...args));
    }),
    clear: vi.fn(() => handlers.clear()),
  };
  return {
    bus,
    createBusScope: vi.fn(() => {
      const cleanups: Array<() => void> = [];
      return {
        on: vi.fn((event: string, fn: TestHandler) => {
          cleanups.push(bus.on(event, fn));
        }),
        dispose: vi.fn(() => {
          for (const u of cleanups) u();
          cleanups.length = 0;
        }),
      };
    }),
  };
});

vi.mock('../../core/state.ts', () => {
  let state: Record<string, unknown> = {
    'playback.mode': null,
    'playback.activity': 'idle',
  };
  return {
    getState: vi.fn((path: string) => state[path]),
    setState: vi.fn((path: string, value: unknown) => {
      state[path] = value;
    }),
    resetState: vi.fn(() => {
      state = {
        'playback.mode': null,
        'playback.activity': 'idle',
      };
    }),
  };
});

vi.mock('../../audio/engine.ts', () => ({
  getAnalyser: vi.fn(() => null),
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: vi.fn(),
  clearManagedTimer: vi.fn(),
}));

vi.mock('../../core/constants.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual };
});

beforeEach(async () => {
  vi.useFakeTimers();
  const [{ resetState }, { getAnalyser }] = await Promise.all([
    import('../../core/state.ts'),
    import('../../audio/engine.ts'),
  ]);
  resetState();
  vi.mocked(getAnalyser).mockReturnValue(null);
  localStorage.clear();
  document.documentElement.setAttribute('data-theme', 'dark');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });

  const wrapper = document.createElement('div');
  wrapper.className = 'vinyl-wrapper';
  Object.defineProperty(wrapper, 'clientWidth', { value: 240, configurable: true });
  document.body.appendChild(wrapper);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Visualizer', () => {
  describe('runtime behavior', () => {
    it('rasterizes for the rendered desktop scale and clamps circular radii to the canvas', async () => {
      vi.resetModules();
      const { setState } = await import('../../core/state.ts');
      const { getAnalyser } = await import('../../audio/engine.ts');
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');

      const wrapper = document.querySelector<HTMLElement>('.vinyl-wrapper')!;
      Object.defineProperties(wrapper, {
        clientWidth: { value: 100, configurable: true },
        clientHeight: { value: 100, configurable: true },
      });
      wrapper.getBoundingClientRect = () =>
        ({
          width: 150,
          height: 150,
          top: 0,
          right: 150,
          bottom: 150,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      vi.stubGlobal('devicePixelRatio', 2);

      const canvas = document.createElement('canvas');
      canvas.id = 'visualizerCanvas';
      document.body.appendChild(canvas);
      const ctx = {
        setTransform: vi.fn(),
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      } as unknown as CanvasRenderingContext2D;
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
      vi.mocked(getAnalyser).mockReturnValue({
        frequencyBinCount: 16,
        getFloatFrequencyData: vi.fn((data: Float32Array) => data.fill(-20)),
      } as unknown as AnalyserNode);
      const frameCallbacks: FrameRequestCallback[] = [];
      vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn((callback: FrameRequestCallback) => {
          frameCallbacks.push(callback);
          return frameCallbacks.length;
        }),
      );
      vi.stubGlobal('cancelAnimationFrame', vi.fn());

      const mod = await import('../visualizer.ts');
      mod.initVisualizer();
      for (let frame = 0; frame < 16; frame++) {
        frameCallbacks.shift()?.(frame * 16);
      }

      // DPR 2 x rendered body scale 1.5 reaches the guarded 3x backing ratio.
      expect(canvas.width).toBe(300);
      expect(canvas.height).toBe(300);
      expect(ctx.setTransform).toHaveBeenCalledWith(3, 0, 0, 3, 0, 0);

      const radii = vi.mocked(ctx.arc).mock.calls.map((call) => call[2]);
      expect(radii).toContain(49.5);
      expect(Math.max(...radii)).toBeLessThanOrEqual(49.5);
    });

    it('resizes through both observed wrapper and visual viewport callbacks', async () => {
      vi.resetModules();
      const { setState } = await import('../../core/state.ts');
      const { getAnalyser } = await import('../../audio/engine.ts');
      const { setManagedTimer } = await import('../../core/timers.ts');
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');

      let logicalSize = 240;
      const wrapper = document.querySelector<HTMLElement>('.vinyl-wrapper')!;
      Object.defineProperties(wrapper, {
        clientWidth: { get: () => logicalSize, configurable: true },
        clientHeight: { get: () => logicalSize, configurable: true },
      });
      wrapper.getBoundingClientRect = () =>
        ({
          width: logicalSize,
          height: logicalSize,
          top: 0,
          right: logicalSize,
          bottom: logicalSize,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;

      const resizeCallbacks: {
        observed?: ResizeObserverCallback;
        viewport?: EventListener;
      } = {};
      const observe = vi.fn();
      class ResizeObserverMock {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.observed = callback;
        }
        observe = observe;
        disconnect = vi.fn();
        unobserve = vi.fn();
      }
      vi.stubGlobal('ResizeObserver', ResizeObserverMock);

      const visualViewport = {
        addEventListener: vi.fn((type: string, listener: EventListener) => {
          if (type === 'resize') resizeCallbacks.viewport = listener;
        }),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('visualViewport', visualViewport);

      const canvas = document.createElement('canvas');
      canvas.id = 'visualizerCanvas';
      document.body.appendChild(canvas);
      const ctx = {
        setTransform: vi.fn(),
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      } as unknown as CanvasRenderingContext2D;
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
      vi.mocked(getAnalyser).mockReturnValue({
        frequencyBinCount: 16,
        getFloatFrequencyData: vi.fn((data: Float32Array) => data.fill(-20)),
      } as unknown as AnalyserNode);
      vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn(() => 1),
      );
      const cancelAnimationFrame = vi.fn();
      vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);

      const mod = await import('../visualizer.ts');
      mod.initVisualizer();

      expect(observe).toHaveBeenCalledWith(wrapper);
      expect(visualViewport.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));

      logicalSize = 320;
      expect(resizeCallbacks.observed).toBeDefined();
      resizeCallbacks.observed?.([], {} as ResizeObserver);
      expect(canvas.width).toBe(320);
      expect(cancelAnimationFrame).toHaveBeenCalled();

      logicalSize = 360;
      expect(resizeCallbacks.viewport).toBeDefined();
      resizeCallbacks.viewport?.(new Event('resize'));
      expect(canvas.width).toBe(360);
      expect(setManagedTimer).toHaveBeenCalledWith('viz-resize', expect.any(Function), 100);
    });

    it('keeps canvas geometry finite when the analyser returns NaN', async () => {
      vi.resetModules();
      const { setState } = await import('../../core/state.ts');
      const { getAnalyser } = await import('../../audio/engine.ts');
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');

      const canvas = document.createElement('canvas');
      canvas.id = 'visualizerCanvas';
      document.body.appendChild(canvas);
      const ctx = {
        setTransform: vi.fn(),
        scale: vi.fn(),
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      } as unknown as CanvasRenderingContext2D;
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
      vi.mocked(getAnalyser).mockReturnValue({
        frequencyBinCount: 16,
        getFloatFrequencyData: vi.fn((data: Float32Array) => data.fill(Number.NaN)),
      } as unknown as AnalyserNode);
      vi.stubGlobal(
        'requestAnimationFrame',
        vi.fn(() => 1),
      );
      vi.stubGlobal('cancelAnimationFrame', vi.fn());

      const mod = await import('../visualizer.ts');
      mod.initVisualizer();

      expect(ctx.arc).toHaveBeenCalled();
      for (const call of vi.mocked(ctx.arc).mock.calls) {
        expect(call.every((value) => typeof value !== 'number' || Number.isFinite(value))).toBe(
          true,
        );
      }
    });

    it('hydrates persisted spectrum mode before drawing the initial resting frame', async () => {
      vi.resetModules();
      localStorage.setItem('musixquare-viz-mode', 'spectrum');

      const restingCanvas = document.createElement('canvas');
      restingCanvas.id = 'visualizerCanvas';
      document.body.appendChild(restingCanvas);

      const ctx = {
        setTransform: vi.fn(),
        scale: vi.fn(),
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      } as unknown as CanvasRenderingContext2D;
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);

      const mod = await import('../visualizer.ts');
      mod.initVisualizer();

      expect(document.body.classList.contains('viz-spectrum')).toBe(true);
      expect(document.body.classList.contains('viz-circular')).toBe(false);
      expect(ctx.lineTo).toHaveBeenCalled();
      expect(ctx.arc).not.toHaveBeenCalled();
    });

    it('redraws a spectrum resting frame when the saved mode is restored after init', async () => {
      vi.resetModules();

      const restingCanvas = document.createElement('canvas');
      restingCanvas.id = 'visualizerCanvas';
      document.body.appendChild(restingCanvas);

      const ctx = {
        setTransform: vi.fn(),
        scale: vi.fn(),
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      } as unknown as CanvasRenderingContext2D;
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);

      const [{ bus }, mod] = await Promise.all([
        import('../../core/events.ts'),
        import('../visualizer.ts'),
      ]);
      mod.initVisualizer();
      vi.mocked(ctx.arc).mockClear();
      vi.mocked(ctx.lineTo).mockClear();

      bus.emit('visualizer:set-type', 'spectrum');

      expect(document.body.classList.contains('viz-spectrum')).toBe(true);
      expect(document.body.classList.contains('viz-circular')).toBe(false);
      expect(ctx.lineTo).toHaveBeenCalled();
      expect(ctx.arc).not.toHaveBeenCalled();
    });

    it('applies the initial paused playback activity through the visualizer subscription', async () => {
      const { setState } = await import('../../core/state.ts');
      setState('playback.mode', 'file');
      setState('playback.activity', 'paused');

      const restingCanvas = document.createElement('canvas');
      restingCanvas.id = 'visualizerCanvas';
      document.body.appendChild(restingCanvas);

      const ctx = {
        setTransform: vi.fn(),
        scale: vi.fn(),
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      } as unknown as CanvasRenderingContext2D;
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);

      const mod = await import('../visualizer.ts');
      mod.initVisualizer();

      expect(ctx.arc).toHaveBeenCalled();
    });

    it('settles a cached circular frame before drawing the final resting frame', async () => {
      vi.resetModules();
      const { setState } = await import('../../core/state.ts');
      const { getAnalyser } = await import('../../audio/engine.ts');
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');

      const restingCanvas = document.createElement('canvas');
      restingCanvas.id = 'visualizerCanvas';
      document.body.appendChild(restingCanvas);

      const ctx = {
        setTransform: vi.fn(),
        scale: vi.fn(),
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        lineTo: vi.fn(),
        moveTo: vi.fn(),
        stroke: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      } as unknown as CanvasRenderingContext2D;
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);

      const analyser = {
        frequencyBinCount: 16,
        getFloatFrequencyData: vi.fn((data: Float32Array) => data.fill(-20)),
      } as unknown as AnalyserNode;
      vi.mocked(getAnalyser).mockReturnValue(analyser);

      const rafCallbacks: FrameRequestCallback[] = [];
      const requestAnimationFrameMock = vi.fn((cb: FrameRequestCallback) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      });
      vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);
      vi.stubGlobal('cancelAnimationFrame', vi.fn());

      const { bus } = await import('../../core/events.ts');
      bus.clear();
      const mod = await import('../visualizer.ts');
      mod.initVisualizer();

      vi.mocked(ctx.arc).mockClear();
      requestAnimationFrameMock.mockClear();
      rafCallbacks.length = 0;

      bus.emit('visualizer:fade-out');

      expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1);
      rafCallbacks[0](performance.now() + 200);
      expect(ctx.arc).toHaveBeenCalled();
    });

    it('keeps spectrum at rest while warming up a fresh analyser start', async () => {
      vi.resetModules();
      localStorage.setItem('musixquare-viz-mode', 'spectrum');

      const { setState } = await import('../../core/state.ts');
      const { getAnalyser } = await import('../../audio/engine.ts');
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');

      const restingCanvas = document.createElement('canvas');
      restingCanvas.id = 'visualizerCanvas';
      document.body.appendChild(restingCanvas);

      const ctx = {
        setTransform: vi.fn(),
        scale: vi.fn(),
        clearRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        lineTo: vi.fn(),
        moveTo: vi.fn(),
        quadraticCurveTo: vi.fn(),
        closePath: vi.fn(),
        stroke: vi.fn(),
        createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      } as unknown as CanvasRenderingContext2D;
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);

      const analyser = {
        context: { sampleRate: 48000 },
        frequencyBinCount: 64,
        smoothingTimeConstant: 0.8,
        getFloatFrequencyData: vi.fn((data: Float32Array) => data.fill(-20)),
      } as unknown as AnalyserNode;
      vi.mocked(getAnalyser).mockReturnValue(analyser);

      const rafCallbacks: FrameRequestCallback[] = [];
      const requestAnimationFrameMock = vi.fn((cb: FrameRequestCallback) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      });
      vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock);
      vi.stubGlobal('cancelAnimationFrame', vi.fn());

      const mod = await import('../visualizer.ts');
      mod.initVisualizer();

      expect(ctx.fill).not.toHaveBeenCalled();
      expect(analyser.smoothingTimeConstant).toBe(0);

      for (const cb of [...rafCallbacks]) {
        cb(performance.now() + 16);
      }

      expect(ctx.fill).not.toHaveBeenCalled();
      expect(analyser.smoothingTimeConstant).toBe(0.8);

      rafCallbacks.at(-1)?.(performance.now() + 32);

      expect(ctx.fill).toHaveBeenCalled();
    });
  });
});
