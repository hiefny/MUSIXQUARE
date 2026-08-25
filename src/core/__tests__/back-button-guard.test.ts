import { describe, expect, it, vi } from 'vitest';
import { createBackButtonGuardController } from '../back-button-guard.ts';

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

describe('back-button guard controller', () => {
  it('re-seeds repeated Back events while the dialog is open and guards the next Back after Stay', async () => {
    let sessionActive = false;
    const pushGuard = vi.fn();
    const confirmation = deferred<boolean>();
    const requestLeaveConfirmation = vi.fn(() => confirmation.promise);
    const onLeaveConfirmed = vi.fn();
    const controller = createBackButtonGuardController({
      isSessionActive: () => sessionActive,
      pushGuard,
      requestLeaveConfirmation,
      onLeaveConfirmed,
    });

    sessionActive = true;
    controller.handleSessionStateChange();
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
    const controller = createBackButtonGuardController({
      isSessionActive: () => true,
      pushGuard,
      requestLeaveConfirmation,
      onLeaveConfirmed,
    });

    controller.handleSessionStateChange();
    controller.handlePopState();
    controller.handlePopState();
    confirmation.resolve(true);
    await flushMicrotasks();

    expect(pushGuard).toHaveBeenCalledTimes(3);
    expect(requestLeaveConfirmation).toHaveBeenCalledTimes(1);
    expect(onLeaveConfirmed).toHaveBeenCalledTimes(1);
  });

  it('does not seed or confirm history navigation while idle', () => {
    const pushGuard = vi.fn();
    const requestLeaveConfirmation = vi.fn(async () => false);
    const controller = createBackButtonGuardController({
      isSessionActive: () => false,
      pushGuard,
      requestLeaveConfirmation,
      onLeaveConfirmed: vi.fn(),
    });

    controller.handleSessionStateChange();
    controller.handlePopState();

    expect(pushGuard).not.toHaveBeenCalled();
    expect(requestLeaveConfirmation).not.toHaveBeenCalled();
  });

  it('does not seed for a provisional setup role and seeds once when setup succeeds', () => {
    let role = 'idle';
    let sessionStarted = false;
    const pushGuard = vi.fn();
    const controller = createBackButtonGuardController({
      isSessionActive: () => sessionStarted && role !== 'idle',
      pushGuard,
      requestLeaveConfirmation: vi.fn(async () => false),
      onLeaveConfirmed: vi.fn(),
    });

    role = 'host';
    controller.handleSessionStateChange();
    expect(pushGuard).not.toHaveBeenCalled();

    sessionStarted = true;
    controller.handleSessionStateChange();
    controller.handleSessionStateChange();
    expect(pushGuard).toHaveBeenCalledOnce();
  });

  it('reports a rejected confirmation once even when the error observer throws', async () => {
    const requestLeaveConfirmation = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('dialog unavailable'))
      .mockResolvedValueOnce(false);
    const onConfirmationError = vi.fn(() => {
      throw new Error('diagnostic observer failed');
    });
    const controller = createBackButtonGuardController({
      isSessionActive: () => true,
      pushGuard: vi.fn(),
      requestLeaveConfirmation,
      onLeaveConfirmed: vi.fn(),
      onConfirmationError,
    });

    controller.handleSessionStateChange();
    controller.handlePopState();
    await flushMicrotasks();

    expect(onConfirmationError).toHaveBeenCalledTimes(1);
    controller.handlePopState();
    await flushMicrotasks();
    expect(requestLeaveConfirmation).toHaveBeenCalledTimes(2);
    expect(onConfirmationError).toHaveBeenCalledTimes(1);
  });
});
