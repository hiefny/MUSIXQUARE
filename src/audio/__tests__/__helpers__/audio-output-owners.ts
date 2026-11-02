/**
 * Harness and driver for the AudioContext output-recovery owner tables
 * (RO-01, docs/design/resource-ownership-registry.md; structural plan C1).
 *
 * The harness part mirrors audio-context-ownership.test.ts: every test loads
 * a fresh module graph of the real owners (context.ts, context-recovery.ts,
 * output-health.ts, ui-sounds.ts, media-session.ts) over one
 * FakeNativeAudioContext, with no module mocks, and removes every listener
 * that graph added.
 *
 * The driver part is the only place that names the owners' sub-steps (the
 * play-request restart's arm/prepare/gesture/requirement calls and the
 * playback-scope attempt queries). It returns normalized answers ('prepared',
 * 'preparing', 'stale', 'same', 'none', booleans, opaque handles), so the
 * tables keep asserting the same public behaviour when those sub-steps are
 * merged behind one owner: only this driver changes.
 */
import { expect, vi } from 'vitest';
import { FakeNativeAudioContext, fakeAudioContextConstructor } from './fake-audio-context.ts';

export const QUEUE_A = '00000000-0000-4000-8000-0000000000a1';
export const QUEUE_B = '00000000-0000-4000-8000-0000000000b2';

async function importOwners() {
  const [events, state, constants, context, recovery, playerState, ownership] = await Promise.all([
    import('../../../core/events.ts'),
    import('../../../core/state.ts'),
    import('../../../core/constants.ts'),
    import('../../context.ts'),
    import('../../context-recovery.ts'),
    import('../../../player/_state.ts'),
    import('../../../player/ownership.ts'),
  ]);
  return {
    bus: events.bus,
    setState: state.setState,
    getState: state.getState,
    PLAYBACK_STATE: constants.PLAYBACK_STATE,
    context,
    recovery,
    playerState,
    ownership,
  };
}

export type Owners = Awaited<ReturnType<typeof importOwners>>;

let loaded: Owners | null = null;
const disposers: Array<() => void> = [];

// ─── Harness ───────────────────────────────────────────────────────

export function setVisibility(state: 'visible' | 'hidden', dispatch = true): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  if (dispatch) document.dispatchEvent(new Event('visibilitychange'));
}

/** Fresh owners whose singleton is `fake`, as engine initialization leaves it. */
export async function loadOwners(fake: FakeNativeAudioContext): Promise<Owners> {
  vi.stubGlobal('AudioContext', fakeAudioContextConstructor(fake));
  vi.resetModules();
  loaded = await importOwners();
  expect(loaded.context.getAudioContext()).toBe(fake);
  return loaded;
}

/** A local file playing in a started session (the playback scope's file identity). */
export function stageFile(o: Owners, queueItemId: string = QUEUE_A): void {
  o.setState('setup.sessionStarted', true);
  o.setState('playback.mode', 'file');
  o.setState('playback.activity', 'playing');
  o.setState('playback.lifecycle', o.PLAYBACK_STATE.PLAYING);
  o.setState('playlist.currentQueueItemId', queueItemId);
  o.setState('files.current', {
    name: 'ro01.mp3',
    indexHint: 0,
    size: 10,
    mime: 'audio/mpeg',
    queueItemId,
    sessionId: 1,
    blob: new File(['audio'], 'ro01.mp3', { type: 'audio/mpeg' }),
  });
  o.playerState.setCurrentAudioBuffer({ duration: 120 } as AudioBuffer);
}

/** A YouTube track playing in a started session (no Web Audio source of its own). */
export function stageYouTube(o: Owners, queueItemId: string = QUEUE_A): void {
  o.setState('setup.sessionStarted', true);
  o.setState('playlist.currentQueueItemId', queueItemId);
  o.ownership.setPlaybackYouTubePlaying();
}

/** A started session with nothing playing (for example while receiving system audio). */
export function stageIdle(o: Owners): void {
  o.setState('setup.sessionStarted', true);
}

/** The engine's statechange binding for this context. */
export function bind(o: Owners, fake: FakeNativeAudioContext): () => void {
  const dispose = o.recovery.bindAudioContextInterruptionRecovery(fake.native);
  disposers.push(dispose);
  return dispose;
}

export interface BusRecord {
  /** audio:output-recovery-needed as `source:reason`. */
  readonly needed: string[];
  readonly neededEvents: Array<{ isCurrent?: () => boolean }>;
  /** playback:local-output-rejoin reasons. */
  readonly rejoins: string[];
  /** youtube:set-local-paused as `paused:reason`. */
  readonly youtubeLocal: string[];
}

export function recordBus(o: Owners): BusRecord {
  const record: BusRecord = { needed: [], neededEvents: [], rejoins: [], youtubeLocal: [] };
  o.bus.on('audio:output-recovery-needed', (event) => {
    record.needed.push(`${event.source}:${event.reason}`);
    record.neededEvents.push(event);
  });
  o.bus.on('playback:local-output-rejoin', (event) => {
    record.rejoins.push(event.reason);
  });
  o.bus.on('youtube:set-local-paused', (paused, reason) => {
    record.youtubeLocal.push(`${String(paused)}:${String(reason ?? '')}`);
  });
  return record;
}

export interface MediaSessionActions {
  play(): void;
  pause(): void;
}

/**
 * Transform media-session.ts and its transport graph once per file, from a
 * beforeAll with its own time budget, so the first row that loads Media
 * Session does not pay that cold transform inside its own timeout. Each row
 * still evaluates a fresh graph (loadOwners resets the module registry);
 * the document/window listeners this warm evaluation adds are removed.
 */
export async function warmMediaSessionGraph(): Promise<void> {
  const targets = [document, window] as EventTarget[];
  const spies = targets.map((target) => vi.spyOn(target, 'addEventListener'));
  try {
    await import('../../../player/media-session.ts');
  } finally {
    targets.forEach((target, index) => {
      const spy = spies[index]!;
      for (const [type, listener, options] of spy.mock.calls) {
        target.removeEventListener(type, listener, options);
      }
      spy.mockRestore();
    });
    vi.resetModules();
  }
}

/** Install media-session.ts on a stub navigator.mediaSession; returns its PLAY/PAUSE handlers. */
export async function loadMediaSession(): Promise<MediaSessionActions> {
  const handlers = new Map<string, MediaSessionActionHandler>();
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: {
      metadata: null,
      playbackState: 'none',
      setActionHandler(action: string, handler: MediaSessionActionHandler | null) {
        if (handler) handlers.set(action, handler);
      },
    },
  });
  const { initMediaSession } = await import('../../../player/media-session.ts');
  initMediaSession();
  return {
    play: () => handlers.get('play')!({ action: 'play' }),
    pause: () => handlers.get('pause')!({ action: 'pause' }),
  };
}

/**
 * Turn UI sounds on and return the touch sound. Its readyOutput path issues
 * the same unowned resume() as the trusted pointerdown/keydown path, which
 * jsdom cannot create, synchronously inside the call.
 */
export async function loadUiTouchSound(): Promise<() => void> {
  const ui = await import('../../ui-sounds.ts');
  ui.setUiSoundsEnabled(true);
  return () => ui.playUiTouchSound();
}

/** The native calls (not their settlements or state changes) in an op slice. */
export function nativeCalls(ops: readonly string[]): string[] {
  return ops.filter((op) => op.endsWith('()'));
}

export interface Timeline {
  /** `ms:entry`, ms since the timeline started on the fake clock. */
  readonly entries: string[];
  /** Add an owner answer or observation at the current fake time. */
  mark(entry: string): void;
  /** Milliseconds since the timeline started. */
  now(): number;
}

/** Record every later fake op, and marks, against the fake clock. */
export function startTimeline(fake: FakeNativeAudioContext): Timeline {
  const t0 = performance.now();
  const entries: string[] = [];
  const now = (): number => Math.round(performance.now() - t0);
  const push = Array.prototype.push;
  Object.defineProperty(fake.ops, 'push', {
    configurable: true,
    value: (...items: string[]): number => {
      for (const item of items) entries.push(`${now()}:${item}`);
      return push.apply(fake.ops, items);
    },
  });
  return { entries, mark: (entry) => entries.push(`${now()}:${entry}`), now };
}

export interface DispatchTrace {
  /** `label@state`, plus `>call()` for each native call the listener made synchronously. */
  readonly order: string[];
  /** Name the listeners added from now on. */
  label(next: string): void;
}

/**
 * Wrap the fake's statechange listeners with labels so a test can read who
 * hears each change, in which order, and which listener issued a native call.
 */
export function traceDispatch(fake: FakeNativeAudioContext): DispatchTrace {
  const order: string[] = [];
  let label = 'unlabelled';
  const wrappers = new Map<EventListenerOrEventListenerObject, EventListener>();
  const add = fake.addEventListener.bind(fake);
  const remove = fake.removeEventListener.bind(fake);
  Object.defineProperty(fake, 'addEventListener', {
    configurable: true,
    value: (type: string, listener: EventListenerOrEventListenerObject | null): void => {
      if (type !== 'statechange' || !listener) {
        add(type, listener);
        return;
      }
      const tag = label;
      const wrapper: EventListener = (event) => {
        const before = fake.ops.length;
        const state = fake.state;
        if (typeof listener === 'function') listener.call(fake, event);
        else listener.handleEvent(event);
        const calls = nativeCalls(fake.ops.slice(before));
        order.push(`${tag}@${state}${calls.map((call) => `>${call}`).join('')}`);
      };
      wrappers.set(listener, wrapper);
      add(type, wrapper);
    },
  });
  Object.defineProperty(fake, 'removeEventListener', {
    configurable: true,
    value: (type: string, listener: EventListenerOrEventListenerObject | null): void => {
      const wrapper = listener ? wrappers.get(listener) : undefined;
      if (listener) wrappers.delete(listener);
      remove(type, wrapper ?? listener);
    },
  });
  return {
    order,
    label: (next) => {
      label = next;
    },
  };
}

export function setupOwnerTest(): void {
  vi.useFakeTimers();
  disposers.length = 0;
  loaded = null;
  setVisibility('visible', false);
  vi.spyOn(document, 'addEventListener');
  vi.spyOn(window, 'addEventListener');
}

export function teardownOwnerTest(): void {
  for (const dispose of disposers.splice(0)) dispose();
  // Every document/window listener this test's module graph added (bindings,
  // Media Session, native-control authority) goes with that graph.
  for (const target of [document, window] as EventTarget[]) {
    const calls = vi.mocked(target.addEventListener).mock.calls;
    for (const [type, listener, options] of calls) {
      target.removeEventListener(type, listener, options);
    }
  }
  loaded?.bus.clear();
  loaded = null;
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState');
  Reflect.deleteProperty(navigator, 'mediaSession');
  localStorage.clear();
}

// ─── Driver: the play-request restart ─────────────────────────────

export type FirstAnswer = 'prepared' | 'preparing' | 'stale';
export type Requirement = 'same' | 'not-current' | 'other' | 'none';

/** One play-request restart, as transport starts it and app.ts's dialog uses it. */
export interface PlayRequest {
  /** The owner's first answer, bounded by its preparation window. */
  readonly first: Promise<FirstAnswer>;
  /** true once the context is concretely parked for this attempt; false when it retired first. */
  readonly prepared: Promise<boolean>;
  /** The foreground incident this attempt belongs to (opaque). */
  readonly incident: object;
  /** The dialog's trusted tap. Call it after `first` settled. */
  tap(): Promise<{ running: boolean }>;
  /**
   * The post-tap clock requirement the dialog reads (today polled every
   * 50 ms): for this attempt and current, for this attempt but no longer
   * current, for another attempt, or none.
   */
  requirement(): Requirement;
  /** Whether a dialog may still act for this attempt. */
  isCurrent(): boolean;
  /**
   * The dialog gives up on this attempt (app.ts retires its token when its
   * requirement wait ends with nothing). true when the owner still held the
   * attempt and retired it now, false when it was already gone.
   */
  retire(): boolean;
}

function startPlayRequest(o: Owners, incident: object): PlayRequest {
  const preparation = o.context.prepareForegroundAudioContextRestart(incident);
  let attempt: Awaited<typeof preparation> = null;
  let settled = false;
  const first = preparation.then((value): FirstAnswer => {
    attempt = value;
    settled = true;
    return value ? value.status : 'stale';
  });
  return {
    first,
    prepared: preparation.then((value) => (value ? value.whenPrepared : false)),
    incident,
    tap: () => {
      if (!settled) throw new Error('tap() before the first answer');
      if (!attempt) return Promise.resolve({ running: false });
      return o.context
        .resumePreparedForegroundAudioContextRestartFromGesture(attempt.attemptToken)
        .then((result) => ({ running: result.running }));
    },
    requirement: () => {
      const requirement = o.context.getPendingForegroundAudioContextRestartClockHealthRequirement();
      if (!requirement) return 'none';
      if (!attempt || requirement.attemptToken !== attempt.attemptToken) return 'other';
      return requirement.isCurrent() ? 'same' : 'not-current';
    },
    isCurrent: () => attempt?.isCurrent() ?? false,
    retire: () =>
      attempt ? o.context.retireForegroundAudioContextRestart(attempt.attemptToken) : false,
  };
}

export const playRequest = {
  /** A foreground incident armed and a restart prepared for it at once. */
  arm(o: Owners, fake: FakeNativeAudioContext): PlayRequest {
    const incident = o.context.armForegroundAudioContextClockHealthCheck(fake.native);
    if (!incident) throw new Error('no foreground incident armed');
    return startPlayRequest(o, incident);
  },
  /**
   * Transport's PLAY after foreground: probe the armed incident's clock and
   * prepare a restart only when it is stalled.
   */
  async afterProbe(o: Owners): Promise<{ probe: string; request: PlayRequest | null }> {
    const check = o.context.getPendingForegroundAudioContextClockHealthCheck();
    if (!check) return { probe: 'no-incident', request: null };
    const health = await o.context.probeAudioContextHealth({
      attemptResume: false,
      context: check.context,
      isCurrent: check.isCurrent,
    });
    if (health.reason !== 'clock-stalled') return { probe: health.reason, request: null };
    return { probe: health.reason, request: startPlayRequest(o, check.token) };
  },
};

/** The foreground incident a PLAY would probe now (opaque), or null. */
export function foregroundIncident(o: Owners): object | null {
  return o.context.getPendingForegroundAudioContextClockHealthCheck()?.token ?? null;
}

/** A new foreground incident, as a later hidden/visible bounce arms one. */
export function armNewIncident(o: Owners, fake: FakeNativeAudioContext): object | null {
  return o.context.armForegroundAudioContextClockHealthCheck(fake.native);
}

// ─── Driver: the playback-scope attempt ───────────────────────────

export interface ScopeView {
  /** A playback-scope attempt exists (any phase), and for which mode. */
  readonly attempt: 'none' | 'file' | 'youtube';
  /** That attempt accepts a trusted gesture now. */
  readonly gesture: boolean;
}

export const playbackScope = {
  /**
   * The background stall inspector's arm, in the play-request vocabulary:
   * 'prepared' within its window, 'preparing' when the window ends with the
   * attempt still preparing, 'stale' when no attempt is left.
   */
  async armStalled(o: Owners, fake: FakeNativeAudioContext): Promise<FirstAnswer> {
    const token = await o.recovery.armPendingAudioContextRecoveryFromBackground(fake.native);
    if (token) return 'prepared';
    return o.recovery.getPendingAudioContextRecoveryAttemptForHealth() ? 'preparing' : 'stale';
  },
  /** The dialog's or hardware PLAY's trusted gesture on the pending attempt. */
  tap(o: Owners): Promise<{ running: boolean }> {
    return o.recovery
      .resumePendingAudioContextInterruptionFromGesture()
      .then((result) => ({ running: result.running }));
  },
  view(o: Owners): ScopeView {
    const attempt = o.recovery.getPendingAudioContextRecoveryAttemptForHealth();
    const mode = o.recovery.hasPendingAudioContextInterruption('youtube') ? 'youtube' : 'file';
    return {
      attempt: attempt ? mode : 'none',
      gesture: o.recovery.getPendingAudioContextInterruptionAttempt() !== null,
    };
  },
  /** The pending attempt (opaque), for identity comparisons. */
  current(o: Owners): object | null {
    return o.recovery.getPendingAudioContextRecoveryAttemptForHealth();
  },
  /** Whether that exact attempt is still the live one. */
  isCurrent(o: Owners, attempt: object): boolean {
    return o.recovery.isAudioContextInterruptionAttemptCurrent(attempt);
  },
  /**
   * A caller drops that exact attempt (app.ts's failed-PLAY dialog cancels a
   * pending attempt this way). true when the owner still held it.
   */
  retire(o: Owners, attempt: object): boolean {
    return o.recovery.cancelPendingAudioContextRecovery(attempt);
  },
  /**
   * The post-tap clock requirement the dialog and Media Session read. It
   * moves a running state-interruption attempt to clock verification, so
   * tests read it only where that is part of the pinned behaviour.
   */
  requirement(o: Owners): Requirement {
    const requirement = o.recovery.getPendingAudioContextClockHealthRequirement();
    if (!requirement) return 'none';
    const attempt = o.recovery.getPendingAudioContextRecoveryAttemptForHealth();
    if (requirement.attemptToken !== attempt) return 'other';
    return requirement.isCurrent() ? 'same' : 'not-current';
  },
};

/** Which owner holds the context now. */
export function ownerView(o: Owners): { request: 'owned' | 'none'; scope: ScopeView } {
  return {
    request: o.context.isForegroundAudioContextRestartOwned(o.context.getAudioContext())
      ? 'owned'
      : 'none',
    scope: playbackScope.view(o),
  };
}

/**
 * The owner side of app.ts's ordinary dialog branch, modelled: app.ts itself
 * is not loaded, so neither its choice of branch nor its own rejoin is pinned
 * here. These are the owner answers that branch reads on a tap when no
 * play-request attempt exists: whether a file attempt is pending, which
 * attempt accepts a gesture, and, after the gesture resume the branch issues,
 * whether the owner still holds that attempt.
 */
export async function ordinaryBranchOwnerSide(o: Owners): Promise<{
  fileAttemptPending: boolean;
  gestureAttempt: object | null;
  afterResume: 'current' | 'retired' | 'no-attempt';
}> {
  const fileAttemptPending = o.recovery.hasPendingAudioContextInterruption('file');
  const gestureAttempt = o.recovery.getPendingAudioContextInterruptionAttempt();
  await o.context.restartAudioContextFromGesture().catch(() => undefined);
  let afterResume: 'current' | 'retired' | 'no-attempt' = 'no-attempt';
  if (gestureAttempt) {
    afterResume = o.recovery.isAudioContextInterruptionAttemptCurrent(gestureAttempt)
      ? 'current'
      : 'retired';
  }
  return { fileAttemptPending, gestureAttempt, afterResume };
}
