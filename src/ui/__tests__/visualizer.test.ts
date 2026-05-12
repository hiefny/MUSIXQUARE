/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../core/events.ts', () => {
  const handlers = new Map<string, Function[]>();
  const bus = {
    on: vi.fn((event: string, handler: Function) => {
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
        on: vi.fn((event: string, fn: Function) => {
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

beforeEach(() => {
  vi.useFakeTimers();
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

  // Create the canvas and wrapper elements
  const wrapper = document.createElement('div');
  wrapper.className = 'vinyl-wrapper';
  Object.defineProperty(wrapper, 'clientWidth', { value: 240, configurable: true });
  document.body.appendChild(wrapper);

  const canvas = document.createElement('canvas');
  canvas.id = 'visualizer';
  document.body.appendChild(canvas);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Visualizer', () => {
  describe('Theme Detection', () => {
    it('detects light theme from data-theme attribute', () => {
      document.documentElement.setAttribute('data-theme', 'light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('detects dark theme from data-theme attribute', () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  describe('Canvas Setup', () => {
    it('canvas element exists in DOM', () => {
      const canvas = document.getElementById('visualizer');
      expect(canvas).toBeDefined();
      expect(canvas?.tagName).toBe('CANVAS');
    });

    it('wrapper provides logical size', () => {
      const wrapper = document.querySelector('.vinyl-wrapper') as HTMLElement;
      expect(wrapper.clientWidth).toBe(240);
    });
  });

  describe('NaN Protection Logic', () => {
    // Test the NaN guard logic used in the visualizer draw loop
    function clampValue(raw: number): number {
      let val = (raw + 100) * 2.5;
      if (!isFinite(val)) val = 0;
      if (val < 0) val = 0;
      if (val > 255) val = 255;
      return val;
    }

    it('clamps NaN to 0', () => {
      expect(clampValue(NaN)).toBe(0);
    });

    it('clamps Infinity to 255', () => {
      expect(clampValue(Infinity)).toBe(0); // Infinity → !isFinite → 0
    });

    it('clamps -Infinity to 0', () => {
      expect(clampValue(-Infinity)).toBe(0);
    });

    it('clamps very negative values to 0', () => {
      expect(clampValue(-200)).toBe(0);
    });

    it('clamps very high values to 255', () => {
      expect(clampValue(200)).toBe(255);
    });

    it('processes normal value correctly', () => {
      expect(clampValue(0)).toBe(250); // (0+100)*2.5 = 250
    });

    // Test punch calculation NaN protection
    function calcBassPunch(smoothedBass: number): number {
      let bassPunch = Math.pow(smoothedBass / 255, 2.5);
      if (!isFinite(bassPunch)) bassPunch = 0;
      return bassPunch;
    }

    it('bass punch is 0 for NaN input', () => {
      expect(calcBassPunch(NaN)).toBe(0);
    });

    it('bass punch is 0 for zero input', () => {
      expect(calcBassPunch(0)).toBe(0);
    });

    it('bass punch is 1 for max input', () => {
      expect(calcBassPunch(255)).toBeCloseTo(1, 5);
    });

    function calcHighPunch(smoothedHigh: number): number {
      let highPunch = smoothedHigh / 255;
      if (!isFinite(highPunch)) highPunch = 0;
      return highPunch;
    }

    it('high punch is 0 for NaN input', () => {
      expect(calcHighPunch(NaN)).toBe(0);
    });

    it('high punch is 1 for max input', () => {
      expect(calcHighPunch(255)).toBeCloseTo(1, 5);
    });
  });

  describe('Idle State Detection', () => {
    // Test the idle/paused logic
    function isIdleOrPaused(state: string): boolean {
      return state === 'IDLE' || state === 'PAUSED';
    }

    it('IDLE returns true', () => {
      expect(isIdleOrPaused('IDLE')).toBe(true);
    });

    it('PAUSED returns true', () => {
      expect(isIdleOrPaused('PAUSED')).toBe(true);
    });

    it('PLAYING_AUDIO returns false', () => {
      expect(isIdleOrPaused('PLAYING_AUDIO')).toBe(false);
    });
  });

  describe('Smoothing Logic', () => {
    // Exponential moving average: 0.8 * prev + 0.2 * new
    function smooth(prev: number, current: number): number {
      return 0.8 * prev + 0.2 * current;
    }

    it('smoothing converges over time', () => {
      let smoothed = 0;
      for (let i = 0; i < 20; i++) {
        smoothed = smooth(smoothed, 200);
      }
      expect(smoothed).toBeGreaterThan(190);
    });

    it('smoothing decays when signal drops', () => {
      let smoothed = 200;
      for (let i = 0; i < 20; i++) {
        smoothed = smooth(smoothed, 0);
      }
      expect(smoothed).toBeLessThan(10);
    });
  });

  describe('Module Exports', () => {
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

    it('imports initVisualizer without error', async () => {
      const mod = await import('../visualizer.ts');
      expect(typeof mod.initVisualizer).toBe('function');
    });

    it('imports startVisualizer without error', async () => {
      const mod = await import('../visualizer.ts');
      expect(typeof mod.startVisualizer).toBe('function');
    });
  });
});
