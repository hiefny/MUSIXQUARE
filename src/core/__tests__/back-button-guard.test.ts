import { describe, expect, it, vi } from 'vitest';
import { createBackButtonGuardController, isGuardedSession } from '../back-button-guard.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function microtasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
type Deps = Parameters<typeof createBackButtonGuardController>[0];
function harness(overrides: Partial<Deps> = {}) {
  let position: 'base' | 'guard' | 'foreign' = 'foreign';
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const state = { session: false, ready: true, navigating: false };
  const windows: { name: string; required?: boolean; closing?: Promise<void> }[] = [];
  const confirmations: ReturnType<typeof deferred<boolean>>[] = [];
  const deps: Deps = {
    isSessionActive: () => state.session,
    hasOpenWindow: () => windows.length > 0,
    closeTopWindow: vi.fn(() => {
      const top = windows.at(-1);
      if (!top) return { handled: false, settled: Promise.resolve() };
      if (!top.required) {
        if (top.closing)
          void top.closing.then(
            () => windows.pop(),
            () => undefined,
          );
        else windows.pop();
        if (top.name === 'leave') confirmations.at(-1)?.resolve(false);
      }
      return { handled: true, settled: top.closing ?? Promise.resolve() };
    }),
    whenSurfaceSettled: () => Promise.resolve(),
    isSurfaceReady: () => state.ready,
    isDocumentVisible: () => true,
    isNavigationPending: () => state.navigating,
    currentHistoryPosition: () => position,
    pushGuard: vi.fn(() => {
      position = 'guard';
    }),
    navigateBack: vi.fn(),
    requestFrame: (fn) => {
      frames.set(++frameId, fn);
      return frameId;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
    requestLeaveConfirmation: vi.fn(() => {
      const result = deferred<boolean>();
      confirmations.push(result);
      windows.push({ name: 'leave' });
      return result.promise;
    }),
    onLeaveConfirmed: vi.fn(() => {
      state.navigating = true;
    }),
    ...overrides,
  };
  const controller = createBackButtonGuardController(deps);
  const frame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  };
  const arm = async () => {
    await microtasks();
    frame();
    frame();
  };
  const pop = (destination: typeof position = 'base') => {
    position = destination;
    controller.handlePopState();
  };
  const start = async () => {
    state.session = true;
    controller.handleStateChange();
    await arm();
  };
  return { controller, deps, state, windows, frames, confirmations, frame, arm, pop, start };
}

describe('deferred Back guard', () => {
  // C6-12: app.ts subscribes handleStateChange to the navigation owner's
  // onNavigationPendingChange, so a Back absorbed during a pending navigation
  // no longer leaves the guard unarmed once that navigation settles.
  it('re-arms one guard when a navigation absorbed a Back and then settles', async () => {
    let pending = false;
    let position: 'base' | 'guard' | 'foreign' = 'base';
    const pushGuard = vi.fn(() => {
      position = 'guard';
    });
    const frames: FrameRequestCallback[] = [];
    const controller = createBackButtonGuardController({
      isSessionActive: () => true,
      hasOpenWindow: () => false,
      closeTopWindow: () => ({ handled: false, settled: Promise.resolve() }),
      whenSurfaceSettled: () => Promise.resolve(),
      isSurfaceReady: () => true,
      isDocumentVisible: () => true,
      isNavigationPending: () => pending,
      currentHistoryPosition: () => position,
      pushGuard,
      navigateBack: vi.fn(),
      requestFrame: (callback) => frames.push(callback),
      cancelFrame: vi.fn(),
      requestLeaveConfirmation: vi.fn(async () => false),
      onLeaveConfirmed: vi.fn(),
    });
    const flushFrames = async (): Promise<void> => {
      for (let round = 0; round < 4; round += 1) {
        await Promise.resolve();
        for (const frame of frames.splice(0)) frame(0);
      }
    };

    controller.handleStateChange();
    await flushFrames();
    expect(pushGuard).toHaveBeenCalledTimes(1);

    // A navigation holds the page; Back pops the guard and is absorbed.
    pending = true;
    controller.handleStateChange();
    position = 'base';
    controller.handlePopState();
    await flushFrames();
    expect(pushGuard).toHaveBeenCalledTimes(1);

    // The navigation recovers: the pending-change event re-arms one guard.
    pending = false;
    controller.handleStateChange();
    controller.handleStateChange();
    await flushFrames();
    expect(pushGuard).toHaveBeenCalledTimes(2);
    expect(position).toBe('guard');
  });

  it('a duplicate base event cannot cancel the only pending guard', async () => {
    const h = harness();
    await h.start();
    h.pop();
    h.pop();
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(2);
    expect(h.deps.requestLeaveConfirmation).toHaveBeenCalledOnce();
  });

  it('an initially hidden document waits until a visible resume', async () => {
    let visible = false;
    const h = harness({ isDocumentVisible: () => visible });
    await h.start();
    h.controller.resume();
    await h.arm();
    expect(h.deps.pushGuard).not.toHaveBeenCalled();
    visible = true;
    h.controller.resume();
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledOnce();
  });

  it('a rejected hard navigation can recover and guard subsequent windows', async () => {
    const h = harness();
    await h.start();
    h.pop();
    h.confirmations[0]!.resolve(true);
    await h.arm();
    h.state.navigating = false;
    h.state.session = false;
    h.windows.length = 0;
    h.controller.recoverNavigation();
    h.windows.push({ name: 'language' });
    h.controller.handleStateChange();
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(2);
    h.pop();
    expect(h.windows).toEqual([]);
  });

  it('takes two frames after the room is shown, never the provisional setup state', async () => {
    const h = harness();
    h.controller.handleStateChange();
    await h.arm();
    expect(h.deps.pushGuard).not.toHaveBeenCalled();
    h.state.session = true;
    h.state.ready = false;
    h.controller.handleStateChange();
    await h.arm();
    expect(h.deps.pushGuard).not.toHaveBeenCalled();
    h.state.ready = true;
    h.controller.handleStateChange();
    await microtasks();
    expect(h.deps.pushGuard).not.toHaveBeenCalled();
    h.frame();
    expect(h.deps.pushGuard).not.toHaveBeenCalled();
    h.frame();
    expect(h.deps.pushGuard).toHaveBeenCalledOnce();
  });

  it('reuses one guard across state changes and an entry after an earlier window', async () => {
    const h = harness();
    h.windows.push({ name: 'account' });
    h.controller.handleStateChange();
    await h.arm();
    h.windows.pop();
    h.controller.handleStateChange();
    await h.start();
    h.controller.handleStateChange();
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledOnce();
  });

  it('closes nested windows one at a time and only then asks to leave', async () => {
    const h = harness();
    await h.start();
    h.windows.push({ name: 'media' }, { name: 'notice' });
    h.pop();
    expect(h.windows.map((x) => x.name)).toEqual(['media']);
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(1);
    await h.arm();
    h.pop();
    expect(h.windows).toEqual([]);
    await h.arm();
    h.pop();
    expect(h.windows.map((x) => x.name)).toEqual(['leave']);
    expect(h.deps.requestLeaveConfirmation).toHaveBeenCalledOnce();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(3);
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(4);
  });

  it('Back on the confirmation means Stay and the next Back can ask again', async () => {
    const h = harness();
    await h.start();
    h.pop();
    await h.arm();
    h.pop();
    await h.arm();
    expect(h.windows).toEqual([]);
    expect(h.deps.onLeaveConfirmed).not.toHaveBeenCalled();
    h.pop();
    await h.arm();
    expect(h.deps.requestLeaveConfirmation).toHaveBeenCalledTimes(2);
  });

  it('explicit Stay restores the same guard without accumulating entries', async () => {
    const h = harness();
    await h.start();
    h.pop();
    await h.arm();
    h.windows.pop();
    h.confirmations[0]!.resolve(false);
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(2);
    h.pop();
    expect(h.deps.requestLeaveConfirmation).toHaveBeenCalledTimes(2);
  });

  it('a required window remains protected without becoming a leave request', async () => {
    const h = harness();
    await h.start();
    h.windows.push({ name: 'required', required: true });
    for (let i = 0; i < 3; i++) {
      h.pop();
      await h.arm();
    }
    expect(h.windows).toHaveLength(1);
    expect(h.deps.requestLeaveConfirmation).not.toHaveBeenCalled();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(4);
  });

  it('waits for actual closing completion, then two frames', async () => {
    const h = harness();
    await h.start();
    const close = deferred<void>();
    h.windows.push({ name: 'screensaver', closing: close.promise });
    h.pop();
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(1);
    close.resolve();
    await microtasks();
    h.frame();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(1);
    h.frame();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(2);
  });

  it('a newly starting surface cancels old frames and waits for the newer close', async () => {
    let surface = Promise.resolve();
    const h = harness({ whenSurfaceSettled: () => surface });
    await h.start();
    h.pop();
    await microtasks();
    h.frame();
    const close = deferred<void>();
    surface = close.promise;
    h.controller.handleStateChange();
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(1);
    close.resolve();
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(2);
  });

  it('re-entrant overlay notifications never seed in the popstate task', async () => {
    const h = harness();
    await h.start();
    vi.mocked(h.deps.closeTopWindow).mockImplementation(() => {
      h.controller.handleStateChange();
      return { handled: true, settled: Promise.resolve() };
    });
    h.pop();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(1);
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(2);
  });

  it('Forward does not close another window or leave another guard behind', async () => {
    const h = harness();
    await h.start();
    h.windows.push({ name: 'media' });
    h.pop();
    h.pop('guard');
    await h.arm();
    expect(h.deps.closeTopWindow).toHaveBeenCalledOnce();
    expect(h.deps.pushGuard).toHaveBeenCalledOnce();
    expect(h.deps.requestLeaveConfirmation).not.toHaveBeenCalled();
    h.pop();
    expect(h.deps.requestLeaveConfirmation).toHaveBeenCalledOnce();
  });

  it('foreign navigation cancels pending rearm without hijacking it', async () => {
    const h = harness();
    await h.start();
    h.pop();
    h.pop('foreign');
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledOnce();
    expect(h.deps.navigateBack).not.toHaveBeenCalled();
  });

  it('an outside-room window closes without navigating the underlying page', async () => {
    const h = harness();
    h.windows.push({ name: 'language' });
    h.controller.handleStateChange();
    await h.arm();
    h.pop();
    await h.arm();
    expect(h.deps.navigateBack).not.toHaveBeenCalled();
    expect(h.deps.pushGuard).toHaveBeenCalledOnce();
  });

  it('an unused outside-room guard carries Back to the actual previous page once', async () => {
    const h = harness();
    h.windows.push({ name: 'language' });
    h.controller.handleStateChange();
    await h.arm();
    h.windows.pop();
    h.controller.handleStateChange();
    h.pop();
    h.pop();
    expect(h.deps.navigateBack).toHaveBeenCalledOnce();
  });

  it('a window declining Back still allows the leave confirmation', async () => {
    const h = harness({ closeTopWindow: () => ({ handled: false, settled: Promise.resolve() }) });
    await h.start();
    h.windows.push({ name: 'guest-demo' });
    h.pop();
    expect(h.deps.requestLeaveConfirmation).toHaveBeenCalledOnce();
  });

  it.each(['before-rearm', 'after-rearm'] as const)(
    'confirmed leave cancels rearm: %s',
    async (timing) => {
      const h = harness();
      await h.start();
      h.pop();
      if (timing === 'after-rearm') await h.arm();
      h.confirmations[0]!.resolve(true);
      await h.arm();
      const count = vi.mocked(h.deps.pushGuard).mock.calls.length;
      h.controller.handleStateChange();
      h.pop();
      await h.arm();
      expect(h.deps.onLeaveConfirmed).toHaveBeenCalledOnce();
      expect(h.deps.pushGuard).toHaveBeenCalledTimes(count);
    },
  );

  it('does not compete with an update or terminal reset', async () => {
    const h = harness();
    await h.start();
    h.pop();
    h.state.navigating = true;
    h.confirmations[0]!.resolve(true);
    await h.arm();
    h.controller.handleStateChange();
    await h.arm();
    expect(h.deps.onLeaveConfirmed).not.toHaveBeenCalled();
    expect(h.deps.pushGuard).toHaveBeenCalledOnce();
  });

  it('cancels a hidden document and resumes only while still needing a guard', async () => {
    const h = harness();
    await h.start();
    h.pop();
    await microtasks();
    h.frame();
    h.controller.suspend();
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledOnce();
    h.controller.resume();
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(2);
    h.pop();
    h.state.session = false;
    h.windows.length = 0;
    h.controller.handleStateChange();
    await h.arm();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(2);
  });

  it('reports failures without loops even when a diagnostic observer throws', async () => {
    const error = new Error('unavailable');
    const h = harness({
      requestLeaveConfirmation: vi.fn().mockRejectedValue(error),
      onConfirmationError: vi.fn(() => {
        throw error;
      }),
    });
    await h.start();
    h.pop();
    await h.arm();
    expect(h.deps.onConfirmationError).toHaveBeenCalledOnce();
    expect(h.deps.pushGuard).toHaveBeenCalledTimes(2);
  });
});

describe('isGuardedSession', () => {
  it('guards started host/guest rooms including PRO presence re-entry', () => {
    for (const role of ['host', 'guest'])
      expect(isGuardedSession({ sessionStarted: true, role, roomId: null })).toBe(true);
    expect(isGuardedSession({ sessionStarted: true, role: 'idle', roomId: 'room' })).toBe(true);
  });
  it('does not guard provisional roles or a reset room', () => {
    expect(isGuardedSession({ sessionStarted: false, role: 'host', roomId: null })).toBe(false);
    expect(isGuardedSession({ sessionStarted: true, role: 'idle', roomId: null })).toBe(false);
  });
});
