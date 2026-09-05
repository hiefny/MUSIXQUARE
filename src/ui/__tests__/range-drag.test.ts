/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installRangeDragGuard } from '../range-drag.ts';

function dispatchPointer(
  range: HTMLInputElement,
  type: string,
  clientX: number,
  pointerId = 1,
  pointerType = 'mouse',
  clientY = 16,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({
    pointerId,
    pointerType,
    isPrimary: pointerId === 1,
    button: 0,
    clientX,
    clientY,
  })) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  range.dispatchEvent(event);
}

function dispatchPointerDown(range: HTMLInputElement, clientX: number): void {
  dispatchPointer(range, 'pointerdown', clientX);
}

function renderRange(direction: 'ltr' | 'rtl'): HTMLInputElement {
  document.body.innerHTML = `
    <input type="range" min="0" max="100" step="1" value="50" style="direction: ${direction}" />
  `;
  const range = document.querySelector<HTMLInputElement>('input[type="range"]')!;
  vi.spyOn(range, 'getBoundingClientRect').mockReturnValue({
    x: 100,
    y: 0,
    left: 100,
    top: 0,
    right: 300,
    bottom: 32,
    width: 200,
    height: 32,
    toJSON: () => ({}),
  });
  return range;
}

describe('range drag direction', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it('maps the physical left edge to the minimum in LTR', () => {
    const range = renderRange('ltr');
    installRangeDragGuard();

    dispatchPointerDown(range, 120);

    expect(range.value).toBe('10');
    expect(range.style.getPropertyValue('--range-progress')).toBe('10%');

    dispatchPointer(range, 'pointerup', 120);
    dispatchPointerDown(range, 280);

    expect(range.value).toBe('90');
    expect(range.style.getPropertyValue('--range-progress')).toBe('90%');
  });

  it('maps the physical right edge to the minimum in RTL', () => {
    const range = renderRange('rtl');
    installRangeDragGuard();

    dispatchPointerDown(range, 120);

    expect(range.value).toBe('90');
    expect(range.style.getPropertyValue('--range-progress')).toBe('90%');

    dispatchPointer(range, 'pointerup', 120);
    dispatchPointerDown(range, 280);

    expect(range.value).toBe('10');
    expect(range.style.getPropertyValue('--range-progress')).toBe('10%');
  });

  it('keeps a second finger from replacing the same slider drag', () => {
    const range = renderRange('ltr');
    const input = vi.fn();
    const change = vi.fn();
    range.addEventListener('input', input);
    range.addEventListener('change', change);
    installRangeDragGuard();

    dispatchPointer(range, 'pointerdown', 140, 1, 'touch');
    dispatchPointer(range, 'pointerdown', 260, 2, 'touch');
    dispatchPointer(range, 'pointermove', 280, 2, 'touch');
    expect(range.value).toBe('20');
    expect(input).toHaveBeenCalledTimes(1);

    dispatchPointer(range, 'pointermove', 180, 1, 'touch');
    expect(range.value).toBe('40');
    expect(range.classList.contains('is-dragging')).toBe(true);
    dispatchPointer(range, 'pointerup', 180, 1, 'touch');
    expect(range.classList.contains('is-dragging')).toBe(false);
    expect(change).toHaveBeenCalledTimes(1);

    dispatchPointer(range, 'pointermove', 240, 2, 'touch');
    dispatchPointer(range, 'pointerup', 240, 2, 'touch');
    expect(range.value).toBe('40');
    expect(change).toHaveBeenCalledTimes(1);
  });

  it('ignores another finger releasing its native implicit capture', () => {
    const range = renderRange('ltr');
    const change = vi.fn();
    range.addEventListener('change', change);
    installRangeDragGuard();

    dispatchPointer(range, 'pointerdown', 140, 1, 'touch');
    dispatchPointer(range, 'pointerdown', 260, 2, 'touch');
    dispatchPointer(range, 'pointerup', 260, 2, 'touch');
    dispatchPointer(range, 'lostpointercapture', 260, 2, 'touch');
    expect(range.classList.contains('is-dragging')).toBe(true);
    expect(change).not.toHaveBeenCalled();

    dispatchPointer(range, 'pointermove', 180, 1, 'touch');
    expect(range.value).toBe('40');
    dispatchPointer(range, 'pointerup', 180, 1, 'touch');
    dispatchPointer(range, 'lostpointercapture', 180, 1, 'touch');
    expect(change).toHaveBeenCalledTimes(1);
  });

  it.each(['pointercancel', 'lostpointercapture'])(
    'releases the owning drag on %s so the next gesture works',
    (type) => {
      const range = renderRange('ltr');
      const change = vi.fn();
      range.addEventListener('change', change);
      installRangeDragGuard();

      dispatchPointer(range, 'pointerdown', 140, 1, 'touch');
      dispatchPointer(range, type, 140, 1, 'touch');
      expect(range.classList.contains('is-dragging')).toBe(false);
      expect(change).toHaveBeenCalledTimes(1);
      dispatchPointer(range, 'pointerdown', 260, 2, 'touch');
      dispatchPointer(range, 'pointermove', 280, 2, 'touch');
      expect(range.value).toBe('90');
      expect(range.classList.contains('is-dragging')).toBe(true);
      dispatchPointer(range, 'pointerup', 280, 2, 'touch');
      expect(change).toHaveBeenCalledTimes(2);
    },
  );

  it('normalizes RTL horizontal arrow keys across browser engines', () => {
    const range = renderRange('rtl');
    const input = vi.fn();
    const change = vi.fn();
    range.addEventListener('input', input);
    range.addEventListener('change', change);
    installRangeDragGuard();

    const right = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    range.dispatchEvent(right);

    expect(right.defaultPrevented).toBe(true);
    expect(range.value).toBe('49');
    expect(range.style.getPropertyValue('--range-progress')).toBe('49%');

    const left = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
      cancelable: true,
    });
    range.dispatchEvent(left);

    expect(left.defaultPrevented).toBe(true);
    expect(range.value).toBe('50');
    expect(range.style.getPropertyValue('--range-progress')).toBe('50%');
    expect(input).toHaveBeenCalledTimes(2);
    expect(change).toHaveBeenCalledTimes(2);
  });

  it('leaves LTR arrow keys to the browser', () => {
    const range = renderRange('ltr');
    installRangeDragGuard();
    const right = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });

    range.dispatchEvent(right);

    expect(right.defaultPrevented).toBe(false);
    expect(range.value).toBe('50');
  });
});
