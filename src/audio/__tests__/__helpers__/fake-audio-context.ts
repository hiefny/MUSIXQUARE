/**
 * Web Audio doubles.
 *
 * `createFakeAudioContext` is for graph-topology tests. Nodes record their
 * outgoing connections, and a targeted disconnect throws like the native API
 * when the connection is missing. Params evaluate setValueAtTime/linear-ramp
 * automation against the manually advanced `currentTime`, so a frozen
 * context keeps a ramp where it was. `trace` records connection changes,
 * impulse installs and automation calls in order.
 *
 * `FakeNativeAudioContext` (below) is for ownership tests of the native
 * running/suspended lifecycle: state transitions, `statechange`, scripted
 * resume()/suspend() latency and ordering, and a clock that can freeze while
 * the state says `running`.
 */

export type FakeTraceEntry =
  | { op: 'connect' | 'disconnect'; from: FakeNode; to: FakeNode | null }
  | { op: 'buffer'; node: FakeNode }
  | { op: 'set' | 'ramp'; param: FakeParam; value: number; time: number };

export interface FakeParam {
  value: number;
  cancelScheduledValues(time: number): void;
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
}

export interface FakeNode {
  readonly kind: string;
  readonly context: FakeAudioContext;
  readonly outputs: Set<FakeNode>;
  readonly gain: FakeParam;
  readonly frequency: FakeParam;
  readonly delayTime: FakeParam;
  type: string;
  buffer: unknown;
  channelCount: number;
  channelCountMode: string;
  channelInterpretation: string;
  connect(destination: FakeNode): FakeNode;
  disconnect(destination?: FakeNode): void;
  [property: string]: unknown;
}

export interface FakeAudioContext {
  state: string;
  currentTime: number;
  readonly sampleRate: number;
  readonly destination: FakeNode;
  readonly trace: FakeTraceEntry[];
  addEventListener(): void;
  removeEventListener(): void;
  [factory: string]: unknown;
}

interface ParamEvent {
  ramp: boolean;
  value: number;
  time: number;
}

function createParam(context: FakeAudioContext, initial: number): FakeParam {
  const events: ParamEvent[] = [];
  let intrinsic = initial;
  const insert = (event: ParamEvent) => {
    const index = events.findIndex((other) => other.time > event.time);
    events.splice(index === -1 ? events.length : index, 0, event);
  };
  const param: FakeParam = {
    get value() {
      let value = intrinsic;
      let time = Number.NEGATIVE_INFINITY;
      for (const event of events) {
        if (event.time <= context.currentTime) {
          value = event.value;
          time = event.time;
          continue;
        }
        if (event.ramp && Number.isFinite(time)) {
          value += (event.value - value) * ((context.currentTime - time) / (event.time - time));
        }
        break;
      }
      return value;
    },
    set value(value: number) {
      // Like the native setter: setValueAtTime(value, currentTime).
      intrinsic = value;
      param.setValueAtTime(value, context.currentTime);
    },
    cancelScheduledValues(time) {
      for (let index = events.length - 1; index >= 0; index--) {
        if (events[index]!.time >= time) events.splice(index, 1);
      }
    },
    setValueAtTime(value, time) {
      insert({ ramp: false, value, time });
      context.trace.push({ op: 'set', param, value, time });
    },
    linearRampToValueAtTime(value, time) {
      insert({ ramp: true, value, time });
      context.trace.push({ op: 'ramp', param, value, time });
    },
  };
  return param;
}

const PARAM_NAMES = [
  'gain',
  'frequency',
  'Q',
  'delayTime',
  'threshold',
  'knee',
  'ratio',
  'attack',
  'release',
] as const;

function createNode(context: FakeAudioContext, kind: string): FakeNode {
  const outputs = new Set<FakeNode>();
  let buffer: unknown = null;
  const node = {
    kind,
    context,
    outputs,
    type: '',
    channelCount: 2,
    channelCountMode: 'max',
    channelInterpretation: 'speakers',
    get buffer() {
      return buffer;
    },
    set buffer(value: unknown) {
      buffer = value;
      context.trace.push({ op: 'buffer', node });
    },
    connect(destination: FakeNode) {
      outputs.add(destination);
      context.trace.push({ op: 'connect', from: node, to: destination });
      return destination;
    },
    disconnect(destination?: FakeNode) {
      if (destination === undefined) outputs.clear();
      else if (!outputs.delete(destination)) {
        throw new DOMException('The node is not connected', 'InvalidAccessError');
      }
      context.trace.push({ op: 'disconnect', from: node, to: destination ?? null });
    },
  } as unknown as FakeNode;
  for (const name of PARAM_NAMES) {
    (node as Record<string, unknown>)[name] = createParam(context, name === 'gain' ? 1 : 0);
  }
  return node;
}

export function createFakeAudioContext(sampleRate = 48_000): FakeAudioContext {
  const context = {
    state: 'running',
    currentTime: 0,
    sampleRate,
    trace: [],
    addEventListener() {},
    removeEventListener() {},
    createBuffer: (channels: number, length: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { length, numberOfChannels: channels, getChannelData: (i: number) => data[i] };
    },
  } as unknown as FakeAudioContext;
  (context as { destination: FakeNode }).destination = createNode(context, 'destination');
  for (const kind of [
    'Gain',
    'ChannelSplitter',
    'ChannelMerger',
    'BiquadFilter',
    'Convolver',
    'Delay',
    'DynamicsCompressor',
    'WaveShaper',
    'Analyser',
    'MediaStreamSource',
  ]) {
    context[`create${kind}`] = () => createNode(context, kind);
  }
  return context;
}

// ─── Native lifecycle double ───────────────────────────────────────

/**
 * What this models, and where each behaviour comes from. No /debug or
 * flight-recorder trace of these orderings exists in docs/ (the frozen-clock
 * protocol landed in adf30981 without a device record), so the fake is
 * calibrated against the WebKit behaviour the owners' own comments record,
 * and every ordering is a per-call parameter rather than a claim about one
 * browser:
 *
 * - `statechange` fires only when the state actually changes (Web Audio
 *   spec); calls on a closed context reject with InvalidStateError.
 * - 'before-settle': the state flips and listeners run before the promise
 *   reaction (the order the structural plan's C1 review attributes to
 *   Chromium).
 * - 'deferred-event': the state flips when the promise settles and the
 *   event fires `stateDelayMs` later (the Web Audio spec queues statechange
 *   as a separate task after resolving the promise).
 * - 'after-settle': the promise settles while the old state is still
 *   visible; the state and its event land `stateDelayMs` later (WebKit
 *   suspend() resolving while still running, `nativeResolvedWithoutPrepared`
 *   in src/audio/context.ts; a delayed WebKit statechange).
 * - 'silent': the state flips with no event (WebKit resume() switching to
 *   running without statechange, `requestRetiredAudioContextSuspendCleanup`
 *   in context.ts; state updated without a timely statechange,
 *   `getPendingAudioContextClockHealthRequirement` in context-recovery.ts).
 * - outcome 'never': the promise never settles (WebKit resume() pending
 *   indefinitely after a page suspension, `ensureRunning` in context.ts).
 * - The clock advances with fake wall time (`performance.now()`) only while
 *   the state is `running`; `freezeClock()` stops it while the state still
 *   says `running` (the WebKit frozen clock, `probeAudioContextHealth`).
 * - `transition()` is an OS or user-agent change (interruption, lock, a
 *   route change) that no caller requested.
 *
 * What it does not model: the node graph (use createFakeAudioContext), the
 * `onstatechange` attribute, autoplay or transient-activation policy (a
 * resume() outside a gesture succeeds unless a plan says otherwise), the
 * WebKit rule that an `interrupted` context resumes only after the
 * interruption ends, real event-loop task boundaries (a zero-latency call
 * settles on a microtask), and output latency.
 *
 * `ops` is the platform-side op log: native calls, their settlement and
 * every state change, in order, so tests can assert what reached the
 * platform without counting calls on application collaborators.
 */
export type FakeNativeState = 'running' | 'suspended' | 'interrupted' | 'closed';

export interface FakeNativeCallPlan {
  /**
   * Fake-timer delay before the call takes effect. 0 (the default) settles on
   * a microtask, sooner than any browser; pass 1 or more where the call must
   * land after a pending promise reaction, as it does in a real event loop.
   */
  readonly latencyMs?: number;
  /** Promise outcome. Default 'resolve'. */
  readonly outcome?: 'resolve' | 'reject' | 'never';
  /**
   * State reached when the call takes effect. Default: `running` for a
   * resolving resume(), `suspended` for a resolving suspend(), otherwise
   * 'unchanged'.
   */
  readonly toState?: FakeNativeState | 'unchanged';
  /** Event order relative to the promise. Default 'before-settle'. */
  readonly statechange?: 'before-settle' | 'deferred-event' | 'after-settle' | 'silent';
  /** For 'deferred-event' and 'after-settle': delay from settlement to the event. */
  readonly stateDelayMs?: number;
}

type NativeCallKind = 'resume' | 'suspend';
type StateListener = EventListenerOrEventListenerObject;

function scheduleNative(callback: () => void, delayMs: number): void {
  if (delayMs > 0) setTimeout(callback, delayMs);
  else queueMicrotask(callback);
}

export class FakeNativeAudioContext {
  readonly sampleRate: number;
  readonly ops: string[] = [];
  /** Plans used once the per-call queue is empty. */
  readonly defaultPlans: Record<NativeCallKind, FakeNativeCallPlan> = { resume: {}, suspend: {} };
  private nativeState: FakeNativeState;
  private clockMode: 'advancing' | 'frozen';
  private clockSeconds: number;
  private clockSegmentStartMs: number | null = null;
  private readonly listeners = new Set<StateListener>();
  private readonly plans: Record<NativeCallKind, FakeNativeCallPlan[]> = {
    resume: [],
    suspend: [],
  };

  constructor(
    options: {
      state?: FakeNativeState;
      clock?: 'advancing' | 'frozen';
      clockSeconds?: number;
      sampleRate?: number;
    } = {},
  ) {
    this.nativeState = options.state ?? 'running';
    this.clockMode = options.clock ?? 'advancing';
    this.clockSeconds = options.clockSeconds ?? 4;
    this.sampleRate = options.sampleRate ?? 48_000;
    this.restartClockSegment();
  }

  /** The double typed as the platform object the owners receive. */
  get native(): AudioContext {
    return this as unknown as AudioContext;
  }

  get state(): FakeNativeState {
    return this.nativeState;
  }

  get currentTime(): number {
    const running =
      this.clockSegmentStartMs === null ? 0 : performance.now() - this.clockSegmentStartMs;
    return this.clockSeconds + Math.max(0, running) / 1_000;
  }

  get statechangeListenerCount(): number {
    return this.listeners.size;
  }

  addEventListener(type: string, listener: StateListener | null): void {
    if (type === 'statechange' && listener) this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: StateListener | null): void {
    if (type === 'statechange' && listener) this.listeners.delete(listener);
  }

  /** Queue plans for the next resume() calls, in call order. */
  planResume(...plans: FakeNativeCallPlan[]): this {
    this.plans.resume.push(...plans);
    return this;
  }

  /** Queue plans for the next suspend() calls, in call order. */
  planSuspend(...plans: FakeNativeCallPlan[]): this {
    this.plans.suspend.push(...plans);
    return this;
  }

  resume(): Promise<void> {
    return this.nativeCall('resume');
  }

  suspend(): Promise<void> {
    return this.nativeCall('suspend');
  }

  close(): Promise<void> {
    this.ops.push('close()');
    this.applyState('closed', true);
    return Promise.resolve();
  }

  /** A state change no caller asked for (OS interruption, lock, route change). */
  transition(state: FakeNativeState, options: { statechange?: boolean } = {}): void {
    this.ops.push(`os:${state}`);
    this.applyState(state, options.statechange !== false);
  }

  /** The WebKit frozen clock: `currentTime` stops even while `running`. */
  freezeClock(): void {
    this.stopClockSegment();
    this.clockMode = 'frozen';
    this.restartClockSegment();
  }

  runClock(): void {
    this.stopClockSegment();
    this.clockMode = 'advancing';
    this.restartClockSegment();
  }

  /** Number of native calls of one kind that reached the platform. */
  calls(kind: NativeCallKind | 'close'): number {
    return this.ops.filter((op) => op === `${kind}()`).length;
  }

  private nativeCall(kind: NativeCallKind): Promise<void> {
    this.ops.push(`${kind}()`);
    if (this.nativeState === 'closed') {
      this.ops.push(`${kind}:rejected`);
      return Promise.reject(new DOMException(`${kind}() on a closed context`, 'InvalidStateError'));
    }
    const plan = this.plans[kind].shift() ?? this.defaultPlans[kind];
    const outcome = plan.outcome ?? 'resolve';
    const target =
      plan.toState ??
      (outcome === 'resolve' ? (kind === 'resume' ? 'running' : 'suspended') : 'unchanged');
    const order = plan.statechange ?? 'before-settle';

    return new Promise<void>((resolve, reject) => {
      const settle = (): void => {
        if (outcome === 'never') return;
        if (outcome === 'reject' || this.nativeState === 'closed') {
          this.ops.push(`${kind}:rejected`);
          reject(new DOMException(`${kind}() rejected by the fake`, 'InvalidStateError'));
          return;
        }
        this.ops.push(`${kind}:resolved`);
        resolve();
      };
      const takeEffect = (dispatch: boolean): void => {
        if (target !== 'unchanged' && this.nativeState !== 'closed') {
          this.applyState(target, dispatch);
        }
      };
      scheduleNative(() => {
        if (order === 'after-settle') {
          settle();
          scheduleNative(() => takeEffect(true), plan.stateDelayMs ?? 0);
          return;
        }
        const before = this.nativeState;
        takeEffect(order === 'before-settle');
        settle();
        if (order === 'deferred-event' && this.nativeState !== before) {
          scheduleNative(() => this.dispatchStatechange(), plan.stateDelayMs ?? 0);
        }
      }, plan.latencyMs ?? 0);
    });
  }

  private applyState(next: FakeNativeState, dispatch: boolean): void {
    if (next === this.nativeState) return;
    this.stopClockSegment();
    this.nativeState = next;
    this.restartClockSegment();
    if (!dispatch) {
      this.ops.push(`state:${next}`);
      return;
    }
    this.dispatchStatechange();
  }

  private dispatchStatechange(): void {
    this.ops.push(`statechange:${this.nativeState}`);
    const event = new Event('statechange');
    for (const listener of [...this.listeners]) {
      if (typeof listener === 'function') listener.call(this, event);
      else listener.handleEvent(event);
    }
  }

  private stopClockSegment(): void {
    if (this.clockSegmentStartMs !== null) {
      this.clockSeconds += Math.max(0, performance.now() - this.clockSegmentStartMs) / 1_000;
    }
    this.clockSegmentStartMs = null;
  }

  private restartClockSegment(): void {
    this.clockSegmentStartMs =
      this.nativeState === 'running' && this.clockMode === 'advancing' ? performance.now() : null;
  }
}

/** A global `AudioContext` constructor whose instances are always `fake`. */
export function fakeAudioContextConstructor(fake: FakeNativeAudioContext): typeof AudioContext {
  return class {
    constructor() {
      return fake;
    }
  } as unknown as typeof AudioContext;
}
