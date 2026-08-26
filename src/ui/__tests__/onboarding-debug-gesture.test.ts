/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface PointerEventInitForTest {
  pointerId?: number;
  pointerType?: string;
  isPrimary?: boolean;
  button?: number;
  clientX?: number;
  clientY?: number;
}

function dispatchPointer(
  target: HTMLElement,
  type: string,
  init: PointerEventInitForTest = {},
): void {
  const event = new Event(type, { bubbles: true });
  const values = {
    pointerId: init.pointerId ?? 1,
    pointerType: init.pointerType ?? 'touch',
    isPrimary: init.isPrimary ?? true,
    button: init.button ?? 0,
    clientX: init.clientX ?? 40,
    clientY: init.clientY ?? 40,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  target.dispatchEvent(event);
}

function dispatchClick(target: HTMLElement, detail: number): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
}

describe('onboarding debug gesture', () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = '<div id="ob-slider-area"><button>next</button></div>';
  });

  it('opens once after ten pointer taps and ignores each synthesized click', async () => {
    const { bindOnboardingDebugGesture } = await import('../onboarding-debug-gesture.ts');
    const target = document.getElementById('ob-slider-area') as HTMLElement;
    const onOpen = vi.fn();
    let clock = 0;

    expect(
      bindOnboardingDebugGesture({
        target,
        signal: new AbortController().signal,
        onOpen,
        now: () => clock,
      }),
    ).toBe(true);

    for (let index = 0; index < 10; index += 1) {
      dispatchPointer(target, 'pointerdown');
      clock += 40;
      dispatchPointer(target, 'pointerup');
      // Coarse-pointer browsers commonly end a tap with a trailing leave.
      dispatchPointer(target, 'pointerleave');
      dispatchClick(target, 1);
      clock += 300;
    }

    expect(onOpen).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 10; index += 1) dispatchClick(target, 0);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('supports desktop click and keyboard-generated click fallback', async () => {
    const { bindOnboardingDebugGesture } = await import('../onboarding-debug-gesture.ts');
    const firstTarget = document.getElementById('ob-slider-area') as HTMLElement;
    const firstOpen = vi.fn();
    let clock = 0;

    bindOnboardingDebugGesture({
      target: firstTarget,
      signal: new AbortController().signal,
      onOpen: firstOpen,
      now: () => clock,
    });
    for (let index = 0; index < 10; index += 1) {
      dispatchClick(firstTarget, 1);
      clock += 100;
    }
    expect(firstOpen).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const secondModule = await import('../onboarding-debug-gesture.ts');
    const secondTarget = document.createElement('div');
    document.body.appendChild(secondTarget);
    const secondOpen = vi.fn();
    secondModule.bindOnboardingDebugGesture({
      target: secondTarget,
      signal: new AbortController().signal,
      onOpen: secondOpen,
      now: () => clock,
    });
    for (let index = 0; index < 10; index += 1) {
      dispatchClick(secondTarget, 0);
      clock += 100;
    }
    expect(secondOpen).toHaveBeenCalledTimes(1);
  });

  it('requires all ten taps to fit inside the five-second window', async () => {
    const { bindOnboardingDebugGesture } = await import('../onboarding-debug-gesture.ts');
    const target = document.getElementById('ob-slider-area') as HTMLElement;
    const onOpen = vi.fn();
    let clock = 0;

    bindOnboardingDebugGesture({
      target,
      signal: new AbortController().signal,
      onOpen,
      now: () => clock,
    });
    for (let index = 0; index < 9; index += 1) {
      dispatchClick(target, 0);
      clock += 500;
    }
    clock = 5_100;
    dispatchClick(target, 0);
    expect(onOpen).not.toHaveBeenCalled();

    for (let index = 0; index < 9; index += 1) {
      clock += 100;
      dispatchClick(target, 0);
    }
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('resets the sequence after movement, cancellation, a long press, or multiple pointers', async () => {
    const { bindOnboardingDebugGesture } = await import('../onboarding-debug-gesture.ts');
    const target = document.getElementById('ob-slider-area') as HTMLElement;
    const onOpen = vi.fn();
    let clock = 0;

    bindOnboardingDebugGesture({
      target,
      signal: new AbortController().signal,
      onOpen,
      now: () => clock,
    });

    for (let index = 0; index < 9; index += 1) {
      dispatchClick(target, 0);
      clock += 100;
    }
    dispatchPointer(target, 'pointerdown');
    dispatchPointer(target, 'pointermove', { clientX: 80 });
    dispatchPointer(target, 'pointerup', { clientX: 80 });
    dispatchClick(target, 1);
    expect(onOpen).not.toHaveBeenCalled();

    for (let index = 0; index < 9; index += 1) {
      clock += 100;
      dispatchClick(target, 0);
    }
    dispatchPointer(target, 'pointerdown');
    dispatchPointer(target, 'pointercancel');
    expect(onOpen).not.toHaveBeenCalled();

    for (let index = 0; index < 9; index += 1) {
      clock += 100;
      dispatchClick(target, 0);
    }
    dispatchPointer(target, 'pointerdown');
    clock += 801;
    dispatchPointer(target, 'pointerup');
    expect(onOpen).not.toHaveBeenCalled();

    for (let index = 0; index < 9; index += 1) {
      clock += 100;
      dispatchClick(target, 0);
    }
    dispatchPointer(target, 'pointerdown', { pointerId: 1, isPrimary: true });
    dispatchPointer(target, 'pointerdown', { pointerId: 2, isPrimary: false });
    dispatchPointer(target, 'pointerup', { pointerId: 1, isPrimary: true });
    dispatchPointer(target, 'pointerup', { pointerId: 2, isPrimary: false });
    expect(onOpen).not.toHaveBeenCalled();

    for (let index = 0; index < 10; index += 1) {
      clock += 100;
      dispatchClick(target, 0);
    }
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('unbinds on abort and refuses absent or already-aborted targets', async () => {
    const { bindOnboardingDebugGesture } = await import('../onboarding-debug-gesture.ts');
    const target = document.getElementById('ob-slider-area') as HTMLElement;
    const onOpen = vi.fn();
    const controller = new AbortController();

    expect(bindOnboardingDebugGesture({ target, signal: controller.signal, onOpen })).toBe(true);
    controller.abort();
    for (let index = 0; index < 10; index += 1) dispatchClick(target, 0);
    expect(onOpen).not.toHaveBeenCalled();

    const aborted = new AbortController();
    aborted.abort();
    expect(bindOnboardingDebugGesture({ target, signal: aborted.signal, onOpen })).toBe(false);
    expect(
      bindOnboardingDebugGesture({ target: null, signal: new AbortController().signal, onOpen }),
    ).toBe(false);
  });
});
