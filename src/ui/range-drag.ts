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
  return rect.width > 0 ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0;
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
