import { describe, expect, it, vi } from 'vitest';
import { createBackButtonGuardController, isGuardedSession } from '../back-button-guard.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type Deps = Parameters<typeof createBackButtonGuardController>[0];

function controllerWith(overrides: Partial<Deps>) {
  const deps: Deps = {
    isSessionActive: () => false,
    hasOpenWindow: () => false,
    closeTopWindow: () => false,
    isNavigationPending: () => false,
    pushGuard: vi.fn(),
    navigateBack: vi.fn(),
    requestLeaveConfirmation: vi.fn(async () => false),
    onLeaveConfirmed: vi.fn(),
    ...overrides,
  };
  return { deps, controller: createBackButtonGuardController(deps) };
}

/** A stack of windows; Back closes the top one unless it is required. */
function windowStack() {
  const windows: { id: string; required?: boolean }[] = [];
  return {
    windows,
    hasOpenWindow: () => windows.length > 0,
    closeTopWindow: vi.fn(() => {
      const top = windows[windows.length - 1];
      if (!top) return false;
      if (!top.required) windows.pop();
      return true;
    }),
  };
}

describe('back-button guard controller', () => {
  it('re-seeds repeated Back events while the dialog is open and guards the next Back after Stay', async () => {
    let sessionActive = false;
    const pushGuard = vi.fn();
    const confirmation = deferred<boolean>();
    const requestLeaveConfirmation = vi.fn(() => confirmation.promise);
    const onLeaveConfirmed = vi.fn();
    const { controller } = controllerWith({
      isSessionActive: () => sessionActive,
      pushGuard,
      requestLeaveConfirmation,
      onLeaveConfirmed,
    });

    sessionActive = true;
    controller.handleStateChange();
    expect(pushGuard).toHaveBeenCalledTimes(1);

    controller.handlePopState();
    controller.handlePopState();
    expect(pushGuard).toHaveBeenCalledTimes(3);
    expect(requestLeaveConfirmation).toHaveBeenCalledTimes(1);

    confirmation.resolve(false);
    await flushMicrotasks();
    controller.handlePopState();

    expect(pushGuard).toHaveBeenCalledTimes(4);
    expect(requestLeaveConfirmation).toHaveBeenCalledTimes(2);
    expect(onLeaveConfirmed).not.toHaveBeenCalled();
  });

  it('keeps one confirmation and one leave action when repeated Back is confirmed', async () => {
    const confirmation = deferred<boolean>();
    const pushGuard = vi.fn();
    const requestLeaveConfirmation = vi.fn(() => confirmation.promise);
    const onLeaveConfirmed = vi.fn();
    const { controller } = controllerWith({
      isSessionActive: () => true,
      pushGuard,
      requestLeaveConfirmation,
      onLeaveConfirmed,
    });

    controller.handleStateChange();
    controller.handlePopState();
    controller.handlePopState();
    confirmation.resolve(true);
    await flushMicrotasks();

    expect(pushGuard).toHaveBeenCalledTimes(3);
    expect(requestLeaveConfirmation).toHaveBeenCalledTimes(1);
    expect(onLeaveConfirmed).toHaveBeenCalledTimes(1);
  });

  it('does not seed, confirm, or navigate while idle with no window', () => {
    const { deps, controller } = controllerWith({});

    controller.handleStateChange();
    controller.handlePopState();

    expect(deps.pushGuard).not.toHaveBeenCalled();
    expect(deps.requestLeaveConfirmation).not.toHaveBeenCalled();
    // This Back did not consume a guard, so the browser already handled it.
    expect(deps.navigateBack).not.toHaveBeenCalled();
  });

  it('does not seed for a provisional setup role and seeds once when setup succeeds', () => {
    let role = 'idle';
    let sessionStarted = false;
    const { deps, controller } = controllerWith({
      isSessionActive: () => sessionStarted && role !== 'idle',
    });

    role = 'host';
    controller.handleStateChange();
    expect(deps.pushGuard).not.toHaveBeenCalled();

    sessionStarted = true;
    controller.handleStateChange();
    controller.handleStateChange();
    expect(deps.pushGuard).toHaveBeenCalledOnce();
  });

  it('reports a rejected confirmation once even when the error observer throws', async () => {
    const requestLeaveConfirmation = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('dialog unavailable'))
      .mockResolvedValueOnce(false);
    const onConfirmationError = vi.fn(() => {
      throw new Error('diagnostic observer failed');
    });
    const { controller } = controllerWith({
      isSessionActive: () => true,
      requestLeaveConfirmation,
      onConfirmationError,
    });

    controller.handleStateChange();
    controller.handlePopState();
    await flushMicrotasks();

    expect(onConfirmationError).toHaveBeenCalledTimes(1);
    controller.handlePopState();
    await flushMicrotasks();
    expect(requestLeaveConfirmation).toHaveBeenCalledTimes(2);
    expect(onConfirmationError).toHaveBeenCalledTimes(1);
  });
});

describe('back-button guard with windows', () => {
  it('closes the top window in a room, one per Back, before asking to leave', async () => {
    const stack = windowStack();
    stack.windows.push({ id: 'language' }, { id: 'dialog' });
    const { deps, controller } = controllerWith({
      isSessionActive: () => true,
      ...stack,
    });
    controller.handleStateChange();

    controller.handlePopState();
    expect(stack.windows.map((w) => w.id)).toEqual(['language']);
    controller.handlePopState();
    expect(stack.windows).toEqual([]);
    expect(deps.requestLeaveConfirmation).not.toHaveBeenCalled();

    controller.handlePopState();
    await flushMicrotasks();
    expect(deps.requestLeaveConfirmation).toHaveBeenCalledOnce();
    // The session stays fenced after each Back: seed + three re-seeds.
    expect(deps.pushGuard).toHaveBeenCalledTimes(4);
    expect(deps.navigateBack).not.toHaveBeenCalled();
  });

  it('outside a room, guards an opened window and ends that Back once it closes', () => {
    const stack = windowStack();
    const { deps, controller } = controllerWith(stack);

    stack.windows.push({ id: 'language' });
    controller.handleStateChange();
    expect(deps.pushGuard).toHaveBeenCalledOnce();

    controller.handlePopState();
    expect(stack.windows).toEqual([]);
    // No window remains and no room runs: no new guard, and the page stays.
    expect(deps.pushGuard).toHaveBeenCalledOnce();
    expect(deps.navigateBack).not.toHaveBeenCalled();
    expect(deps.requestLeaveConfirmation).not.toHaveBeenCalled();
  });

  it('outside a room, re-seeds while another window is still open', () => {
    const stack = windowStack();
    const { deps, controller } = controllerWith(stack);
    stack.windows.push({ id: 'account' }, { id: 'dialog' });
    controller.handleStateChange();

    controller.handlePopState();
    expect(stack.windows.map((w) => w.id)).toEqual(['account']);
    expect(deps.pushGuard).toHaveBeenCalledTimes(2);
  });

  it('outside a room, carries a Back on when a window closed another way', () => {
    const stack = windowStack();
    const { deps, controller } = controllerWith(stack);
    stack.windows.push({ id: 'language' });
    controller.handleStateChange();

    // Closed with its own button: the guard entry stays behind.
    stack.windows.pop();
    controller.handleStateChange();
    controller.handlePopState();

    expect(deps.navigateBack).toHaveBeenCalledOnce();
    expect(deps.pushGuard).toHaveBeenCalledOnce();
  });

  it('keeps a required window open and still fences the next Back', () => {
    const stack = windowStack();
    stack.windows.push({ id: 'audio-recovery', required: true });
    const { deps, controller } = controllerWith({ isSessionActive: () => true, ...stack });
    controller.handleStateChange();

    controller.handlePopState();
    controller.handlePopState();

    expect(stack.windows).toHaveLength(1);
    expect(deps.requestLeaveConfirmation).not.toHaveBeenCalled();
    expect(deps.pushGuard).toHaveBeenCalledTimes(3);
  });

  it('decides the guard once after the window closes during its Back', () => {
    const stack = windowStack();
    let controller!: ReturnType<typeof createBackButtonGuardController>;
    const closeTopWindow = vi.fn(() => {
      const used = stack.closeTopWindow();
      // A closing window re-syncs the modal stack synchronously.
      controller.handleStateChange();
      return used;
    });
    const harness = controllerWith({ ...stack, closeTopWindow });
    controller = harness.controller;
    stack.windows.push({ id: 'dialog' });
    controller.handleStateChange();

    controller.handlePopState();

    expect(harness.deps.pushGuard).toHaveBeenCalledOnce();
    expect(harness.deps.navigateBack).not.toHaveBeenCalled();
  });

  it('passes Back on when the top window does not use it', async () => {
    const { deps, controller } = controllerWith({
      isSessionActive: () => true,
      hasOpenWindow: () => true,
      // A guest who cannot end the demo still reaches the leave confirmation.
      closeTopWindow: () => false,
    });
    controller.handleStateChange();

    controller.handlePopState();
    await flushMicrotasks();

    expect(deps.requestLeaveConfirmation).toHaveBeenCalledOnce();
  });

  it('does not seed or answer Back while a reset navigates away', () => {
    const stack = windowStack();
    stack.windows.push({ id: 'dialog' });
    const { deps, controller } = controllerWith({
      isSessionActive: () => true,
      isNavigationPending: () => true,
      ...stack,
    });

    controller.handleStateChange();
    controller.handlePopState();

    expect(deps.pushGuard).not.toHaveBeenCalled();
    expect(stack.closeTopWindow).not.toHaveBeenCalled();
    expect(deps.requestLeaveConfirmation).not.toHaveBeenCalled();
    expect(deps.navigateBack).not.toHaveBeenCalled();
  });

  it('re-seeds a Back during a confirmed leave so it still pops two entries', async () => {
    let navigating = false;
    const { deps, controller } = controllerWith({
      isSessionActive: () => true,
      isNavigationPending: () => navigating,
      requestLeaveConfirmation: vi.fn(async () => true),
      onLeaveConfirmed: vi.fn(() => {
        navigating = true;
      }),
    });
    controller.handleStateChange();
    controller.handlePopState();
    await flushMicrotasks();
    expect(deps.onLeaveConfirmed).toHaveBeenCalledOnce();

    controller.handlePopState();

    expect(deps.pushGuard).toHaveBeenCalledTimes(3);
    expect(deps.requestLeaveConfirmation).toHaveBeenCalledOnce();
  });
});

describe('isGuardedSession', () => {
  it('guards a started room, including a PRO room re-entering presence', () => {
    expect(isGuardedSession({ sessionStarted: true, role: 'host', roomId: null })).toBe(true);
    expect(isGuardedSession({ sessionStarted: true, role: 'guest', roomId: null })).toBe(true);
    // Re-entry projects the idle role while the room context stays set.
    expect(isGuardedSession({ sessionStarted: true, role: 'idle', roomId: 'room-1' })).toBe(true);
  });

  it('does not guard setup roles or a reset room', () => {
    expect(isGuardedSession({ sessionStarted: false, role: 'host', roomId: null })).toBe(false);
    expect(isGuardedSession({ sessionStarted: false, role: 'idle', roomId: 'room-1' })).toBe(false);
    expect(isGuardedSession({ sessionStarted: true, role: 'idle', roomId: null })).toBe(false);
  });
});
