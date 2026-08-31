function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getStepPrecision(stepText: string): number {
  if (!stepText || stepText === 'any' || !stepText.includes('.')) return 0;
  return stepText.split('.')[1]?.length ?? 0;
}

function getRangeBounds(range: HTMLInputElement): { min: number; max: number } {
  const parsedMin = Number(range.min);
  const parsedMax = Number(range.max);
  const min = Number.isFinite(parsedMin) ? parsedMin : 0;
  const max = Number.isFinite(parsedMax) ? parsedMax : 100;
  return max >= min ? { min, max } : { min: max, max: min };
}

export function syncRangeProgress(range: HTMLInputElement): void {
  const { min, max } = getRangeBounds(range);
  const value = Number(range.value);
  const progress =
    max > min && Number.isFinite(value) ? clamp(((value - min) / (max - min)) * 100, 0, 100) : 0;
  range.style.setProperty('--range-progress', `${progress}%`);
}

function syncAllRangeProgress(root: ParentNode = document): void {
  root
    .querySelectorAll<HTMLInputElement>('input[type="range"]')
    .forEach((range) => syncRangeProgress(range));
}

function getRangeRatio(range: HTMLInputElement, event: PointerEvent): number {
  const rect = range.getBoundingClientRect();
  if (range.classList.contains('eq-slider')) {
    return rect.height > 0 ? clamp((rect.bottom - event.clientY) / rect.height, 0, 1) : 0;
  }
  if (rect.width <= 0) return 0;

  const physicalRatio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  return getComputedStyle(range).direction === 'rtl' ? 1 - physicalRatio : physicalRatio;
}

function getValueFromPointer(range: HTMLInputElement, event: PointerEvent): string {
  const { min, max } = getRangeBounds(range);
  const step = range.step && range.step !== 'any' ? Number(range.step) : NaN;
  const ratio = getRangeRatio(range, event);
  let next = min + (max - min) * ratio;

  if (Number.isFinite(step) && step > 0) {
    next = min + Math.round((next - min) / step) * step;
    next = Number(next.toFixed(getStepPrecision(range.step)));
  }

  return String(clamp(next, min, max));
}

function applyRangeValue(range: HTMLInputElement, event: PointerEvent): void {
  const next = getValueFromPointer(range, event);
  if (range.value === next) return;

  range.value = next;
  syncRangeProgress(range);
  range.dispatchEvent(new Event('input', { bubbles: true }));
}

function applyRtlHorizontalArrow(range: HTMLInputElement, event: KeyboardEvent): void {
  if (getComputedStyle(range).direction !== 'rtl') return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

  // Chromium follows the range's RTL direction for horizontal arrows while
  // WebKit historically keeps ArrowRight=increase. Own the two horizontal
  // keys so keyboard, pointer geometry, and the painted track agree in every
  // engine: moving physically left increases; moving right decreases.
  const previous = range.value;
  try {
    if (event.key === 'ArrowLeft') range.stepUp();
    else range.stepDown();
  } catch {
    // `step="any"` cannot be advanced through stepUp/stepDown. Leave those
    // future callers to the engine by returning before preventDefault().
    return;
  }
  event.preventDefault();
  if (range.value === previous) return;

  syncRangeProgress(range);
  range.dispatchEvent(new Event('input', { bubbles: true }));
  range.dispatchEvent(new Event('change', { bubbles: true }));
}

export function installRangeDragGuard(root: ParentNode = document): void {
  const ranges = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="range"]'));
  requestAnimationFrame(() => syncAllRangeProgress(root));

  ranges.forEach((range) => {
    if (range.dataset.rangeDragGuard === '1') return;
    range.dataset.rangeDragGuard = '1';

    let activePointerId: number | null = null;
    syncRangeProgress(range);
    range.addEventListener('input', () => syncRangeProgress(range));
    range.addEventListener('change', () => syncRangeProgress(range));
    range.addEventListener('blur', () => range.classList.remove('is-pointer-focused'));
    range.addEventListener('keydown', (event) => {
      range.classList.remove('is-pointer-focused');
      applyRtlHorizontalArrow(range, event);
    });

    const finishDrag = (event?: PointerEvent) => {
      if (activePointerId === null) return;
      if (event && event.pointerId !== activePointerId) return;

      try {
        if (event && range.hasPointerCapture(event.pointerId)) {
          range.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Some mobile browsers release capture before pointerup reaches us.
      }

      activePointerId = null;
      range.classList.remove('is-dragging');
      range.dispatchEvent(new Event('change', { bubbles: true }));
    };

    range.addEventListener('pointerdown', (event) => {
      if (range.disabled || event.button !== 0) return;

      activePointerId = event.pointerId;
      range.classList.add('is-dragging');
      range.classList.add('is-pointer-focused');
      range.focus({ preventScroll: true });

      try {
        range.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is a reliability boost, not a hard dependency.
      }

      if (event.cancelable) event.preventDefault();
      applyRangeValue(range, event);
    });

    range.addEventListener('pointermove', (event) => {
      if (event.pointerId !== activePointerId) return;
      if (event.cancelable) event.preventDefault();
      applyRangeValue(range, event);
    });

    range.addEventListener('pointerup', finishDrag);
    range.addEventListener('pointercancel', finishDrag);
    range.addEventListener('lostpointercapture', () => finishDrag());
  });
}
