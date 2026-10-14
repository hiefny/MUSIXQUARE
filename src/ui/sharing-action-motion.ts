/** The sender's two action buttons merge without changing either click target. */
export function createSharingActionMotion(
  container: HTMLElement,
  syncButton: HTMLButtonElement,
  mediaButton: HTMLButtonElement,
  signal: AbortSignal,
): { update: (sharing: boolean) => void } {
  let sharing: boolean | undefined;
  let timer = 0;
  let pointer: { x: number; y: number } | null = null;
  let movedDuringMorph = false;
  let lockedMediaHover = false;
  const initialDisabled = syncButton.disabled;
  const initialInert = syncButton.hasAttribute('inert');
  const initialAriaHidden = syncButton.getAttribute('aria-hidden');
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  function cancelTimer(): void {
    window.clearTimeout(timer);
    timer = 0;
  }

  function releaseHover(): void {
    delete container.dataset.hoverLocked;
    container.style.removeProperty('--motion-media-bg');
  }

  function containsPointer(button: HTMLButtonElement): boolean {
    if (!pointer) return false;
    const rect = button.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      pointer.x >= rect.left &&
      pointer.x <= rect.right &&
      pointer.y >= rect.top &&
      pointer.y <= rect.bottom
    );
  }

  function finishMorph(): void {
    cancelTimer();
    delete container.dataset.morphing;
    // Geometry moving beneath a stationary pointer is not fresh hover intent.
    // In particular, splitting reveals Sync beneath the left side of Stop.
    // Popup dismissal can reconcile :hover after transitionend, so agreement
    // with the current CSS pseudo-class alone cannot safely release the lock.
    const samePointerTarget =
      !pointer ||
      (lockedMediaHover === containsPointer(mediaButton) &&
        (sharing || !containsPointer(syncButton)));
    const sameHover =
      samePointerTarget &&
      lockedMediaHover === mediaButton.matches(':hover') &&
      (sharing || !syncButton.matches(':hover'));
    if (movedDuringMorph || sameHover || reducedMotion?.matches) releaseHover();
  }

  function gap(): number {
    return Number.parseFloat(getComputedStyle(container).columnGap) || 12;
  }

  function measure(width: number): void {
    if (signal.aborted || width <= 0) return;
    // clientWidth / contentRect are layout pixels: unlike boundingClientRect,
    // they do not include the desktop player panel's visual scale transform.
    container.style.setProperty(
      '--play-action-slot-width',
      `${Math.max(0, (width - gap()) / 2)}px`,
    );
  }

  const observer =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          const entry = entries.find((entry) => entry.target === container);
          if (entry) measure(entry.contentRect.width);
        });

  function restoreSync(): void {
    syncButton.disabled = initialDisabled;
    syncButton.toggleAttribute('inert', initialInert);
    if (initialAriaHidden === null) syncButton.removeAttribute('aria-hidden');
    else syncButton.setAttribute('aria-hidden', initialAriaHidden);
  }

  function dispose(): void {
    cancelTimer();
    observer?.disconnect();
    delete container.dataset.morphing;
    delete container.dataset.sharing;
    releaseHover();
    container.style.removeProperty('--play-action-slot-width');
    restoreSync();
  }

  function update(next: boolean): void {
    if (signal.aborted || next === sharing) return;
    cancelTimer();
    if (sharing !== undefined && !reducedMotion?.matches) {
      const rect = container.getBoundingClientRect();
      const scale = container.clientWidth > 0 ? rect.width / container.clientWidth : 1;
      const slotWidth = (rect.width - gap() * scale) / 2;
      const rtl = getComputedStyle(container).direction === 'rtl';
      const left = next || rtl ? rect.left : rect.right - slotWidth;
      const right = next || !rtl ? rect.right : rect.left + slotWidth;
      lockedMediaHover =
        mediaButton.matches(':hover') &&
        pointer !== null &&
        pointer.x >= left &&
        pointer.x <= right &&
        pointer.y >= rect.top &&
        pointer.y <= rect.bottom;
      container.style.setProperty(
        '--motion-media-bg',
        next
          ? lockedMediaHover
            ? 'var(--play-action-stop-hover)'
            : 'var(--play-action-stop-surface)'
          : lockedMediaHover
            ? 'var(--surface-3)'
            : 'var(--play-action-surface)',
      );
      container.dataset.hoverLocked = 'true';
      container.dataset.morphing = 'true';
      movedDuringMorph = false;
      // transitionend handles visible animations; this also settles a hidden
      // panel or an interrupted width transition without a perpetual lock.
      timer = window.setTimeout(finishMorph, 350);
    } else {
      delete container.dataset.morphing;
      releaseHover();
    }
    if (next) {
      if (document.activeElement === syncButton) mediaButton.focus({ preventScroll: true });
      syncButton.disabled = true;
      syncButton.setAttribute('inert', '');
      syncButton.setAttribute('aria-hidden', 'true');
    } else {
      restoreSync();
    }
    sharing = next;
    container.dataset.sharing = String(next);
  }

  if (!signal.aborted) {
    const options = { signal, passive: true };
    document.addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
        const moved = !pointer || pointer.x !== event.clientX || pointer.y !== event.clientY;
        pointer = { x: event.clientX, y: event.clientY };
        if (!moved) return;
        if (container.dataset.morphing) movedDuringMorph = true;
        else releaseHover();
      },
      options,
    );
    document.addEventListener(
      'pointerdown',
      (event) => {
        pointer = event.pointerType === 'touch' ? null : { x: event.clientX, y: event.clientY };
        if (!container.dataset.morphing) releaseHover();
      },
      { ...options, capture: true },
    );
    document.addEventListener(
      'keydown',
      () => {
        if (!container.dataset.morphing) releaseHover();
      },
      { signal },
    );
    mediaButton.addEventListener(
      'transitionend',
      (event) => {
        if (event.target === mediaButton && event.propertyName === 'width') finishMorph();
      },
      { signal },
    );
    reducedMotion?.addEventListener?.('change', finishMorph, { signal });
    signal.addEventListener('abort', dispose, { once: true });
    measure(container.clientWidth);
    observer?.observe(container);
  }

  return { update };
}
