/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSharingActionMotion } from '../sharing-action-motion.ts';

describe('sharing action motion lifecycle', () => {
  let abort: AbortController;
  let resize: ResizeObserverCallback;
  const disconnect = vi.fn();
  let reduced = false;

  beforeEach(() => {
    vi.useFakeTimers();
    reduced = false;
    abort = new AbortController();
    disconnect.mockClear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return reduced;
      },
      addEventListener: vi.fn(),
    }));
    document.body.innerHTML = `
      <div class="play-action-buttons" style="column-gap:12px">
        <button id="sync">Sync</button><button id="media">Media</button>
      </div>`;
  });

  afterEach(() => {
    abort.abort();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function setup() {
    const container = document.querySelector<HTMLElement>('.play-action-buttons')!;
    const sync = document.getElementById('sync') as HTMLButtonElement;
    const media = document.getElementById('media') as HTMLButtonElement;
    Object.defineProperty(container, 'clientWidth', { value: 342 });
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 342,
      top: 0,
      bottom: 56,
      width: 342,
      height: 56,
    } as DOMRect);
    const hover = { sync: false, media: false };
    vi.spyOn(sync, 'matches').mockImplementation(() => hover.sync);
    vi.spyOn(media, 'matches').mockImplementation(() => hover.media);
    vi.spyOn(sync, 'getBoundingClientRect').mockImplementation(() => {
      const rtl = container.style.direction === 'rtl';
      return new DOMRect(rtl ? 177 : 0, 0, container.dataset.sharing === 'true' ? 0 : 165, 56);
    });
    vi.spyOn(media, 'getBoundingClientRect').mockImplementation(() => {
      const full = container.dataset.sharing === 'true';
      const rtl = container.style.direction === 'rtl';
      return new DOMRect(full || rtl ? 0 : 177, 0, full ? 342 : 165, 56);
    });
    const decoration = createSharingActionMotion(container, sync, media, abort.signal);
    // The eager controller commits semantic state after motion reads geometry.
    const motion = {
      update(next: boolean) {
        decoration.update(next);
        if (!abort.signal.aborted) container.dataset.sharing = String(next);
      },
    };
    return { container, sync, media, hover, motion };
  }

  function pointer(type: 'pointermove' | 'pointerdown', x: number, y = 20): void {
    const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    document.dispatchEvent(event);
  }

  function widthTransitionEnd(media: HTMLButtonElement): void {
    const event = new Event('transitionend');
    Object.defineProperty(event, 'propertyName', { value: 'width' });
    media.dispatchEvent(event);
  }

  function resizeEntry(target: Element, width: number): ResizeObserverEntry {
    return {
      target,
      contentRect: new DOMRectReadOnly(0, 0, width, 56),
      contentBoxSize: [{ inlineSize: width, blockSize: 56 }],
      borderBoxSize: [{ inlineSize: width, blockSize: 56 }],
      devicePixelContentBoxSize: [{ inlineSize: width, blockSize: 56 }],
    };
  }

  it('does not own visible state, focus or accessibility, even when disposed', () => {
    const { container, sync, media } = setup();
    const child = new AbortController();
    const motion = createSharingActionMotion(container, sync, media, child.signal);
    container.dataset.sharing = 'true';
    sync.setAttribute('aria-hidden', 'true');
    sync.setAttribute('inert', '');
    sync.disabled = true;
    const focus = vi.spyOn(media, 'focus');
    motion.update(false);
    child.abort();
    expect(container.dataset.sharing).toBe('true');
    expect(sync.disabled).toBe(true);
    expect(sync.hasAttribute('inert')).toBe(true);
    expect(sync.getAttribute('aria-hidden')).toBe('true');
    expect(focus).not.toHaveBeenCalled();
  });

  it('does not restart the morph when an unrelated state or translation refresh repeats its state', () => {
    const { container, motion } = setup();
    motion.update(false);
    expect(vi.getTimerCount()).toBe(0);
    motion.update(true);
    vi.advanceTimersByTime(300);
    motion.update(true);
    vi.advanceTimersByTime(50);
    expect(container.dataset.morphing).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a normal surface when Stop splits under a stationary pointer over the new Sync button', () => {
    const { container, media, hover, motion } = setup();
    motion.update(true);
    hover.media = true;
    pointer('pointerdown', 40);
    motion.update(false);
    expect(container.style.getPropertyValue('--motion-media-bg')).toBe(
      'var(--play-action-surface)',
    );
    hover.media = false;
    hover.sync = true;
    widthTransitionEnd(media);
    expect(container.dataset.morphing).toBeUndefined();
    expect(container.dataset.hoverLocked).toBe('true');
    pointer('pointermove', 40);
    expect(container.dataset.hoverLocked).toBe('true');
    pointer('pointermove', 41);
    expect(container.dataset.hoverLocked).toBeUndefined();
  });

  it('keeps the existing Media hover when splitting from the right side instead of flashing gray', () => {
    const { container, media, hover, motion } = setup();
    motion.update(true);
    hover.media = true;
    pointer('pointerdown', 280);
    motion.update(false);
    expect(container.style.getPropertyValue('--motion-media-bg')).toBe('var(--surface-3)');
    widthTransitionEnd(media);
    expect(container.dataset.hoverLocked).toBeUndefined();
  });

  it('does not treat expansion beneath a still pointer as an intentional hover', () => {
    const { container, media, hover, motion } = setup();
    motion.update(false);
    pointer('pointermove', 40);
    motion.update(true);
    expect(container.style.getPropertyValue('--motion-media-bg')).toBe(
      'var(--play-action-stop-surface)',
    );
    hover.media = true;
    widthTransitionEnd(media);
    expect(container.dataset.hoverLocked).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(container.dataset.hoverLocked).toBeUndefined();
  });

  it('mirrors the destination hover region in RTL', () => {
    const { container, media, hover, motion } = setup();
    container.style.direction = 'rtl';
    motion.update(true);
    hover.media = true;
    pointer('pointerdown', 30);
    motion.update(false);
    expect(container.style.getPropertyValue('--motion-media-bg')).toBe('var(--surface-3)');
    widthTransitionEnd(media);
    expect(container.dataset.hoverLocked).toBeUndefined();
  });

  it('keeps an expanded surface locked when popup dismissal applies hover after the width transition', () => {
    const { container, media, hover, motion } = setup();
    motion.update(false);
    pointer('pointermove', 40);
    motion.update(true);
    // The pointer already lies inside Stop, but closing the source picker
    // delays :hover reconciliation until after the width transition ends.
    expect(hover.media).toBe(false);
    widthTransitionEnd(media);
    expect(container.dataset.hoverLocked).toBe('true');
    hover.media = true;
    vi.advanceTimersByTime(1_000);
    expect(container.style.getPropertyValue('--motion-media-bg')).toBe(
      'var(--play-action-stop-surface)',
    );
    expect(container.dataset.hoverLocked).toBe('true');
    pointer('pointermove', 41);
    expect(container.dataset.hoverLocked).toBeUndefined();
  });

  it('keeps a split surface locked when the newly revealed Sync gains hover only after the transition', () => {
    const { container, media, hover, motion } = setup();
    motion.update(true);
    hover.media = true;
    pointer('pointerdown', 40);
    motion.update(false);
    hover.media = false;
    expect(hover.sync).toBe(false);
    widthTransitionEnd(media);
    expect(container.dataset.hoverLocked).toBe('true');
    hover.sync = true;
    vi.advanceTimersByTime(1_000);
    expect(container.style.getPropertyValue('--motion-media-bg')).toBe(
      'var(--play-action-surface)',
    );
    expect(container.dataset.hoverLocked).toBe('true');
    pointer('pointermove', 41);
    expect(container.dataset.hoverLocked).toBeUndefined();
  });

  it('unlocks normally when the pointer remains outside both final button rectangles', () => {
    const { container, media, motion } = setup();
    motion.update(false);
    pointer('pointermove', 40, 120);
    motion.update(true);
    widthTransitionEnd(media);
    expect(container.dataset.hoverLocked).toBeUndefined();
    motion.update(false);
    widthTransitionEnd(media);
    expect(container.dataset.hoverLocked).toBeUndefined();
  });

  it('uses unscaled layout dimensions and ignores resize callbacks after disposal', () => {
    const { container, motion } = setup();
    expect(container.style.getPropertyValue('--play-action-slot-width')).toBe('165px');
    resize([resizeEntry(container, 332)], {} as ResizeObserver);
    expect(container.style.getPropertyValue('--play-action-slot-width')).toBe('160px');
    motion.update(false);
    motion.update(true);
    abort.abort();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(container.dataset.sharing).toBe('true');
    expect(container.dataset.hoverLocked).toBeUndefined();
    expect(container.style.getPropertyValue('--play-action-slot-width')).toBe('');
    resize([resizeEntry(container, 400)], {} as ResizeObserver);
    motion.update(true);
    expect(container.style.getPropertyValue('--play-action-slot-width')).toBe('');
    expect(container.dataset.sharing).toBe('true');
  });

  it('removes old pointer handlers before reinitializing', () => {
    const { container, sync, media, motion } = setup();
    motion.update(true);
    abort.abort();
    expect(sync.disabled).toBe(false);
    abort = new AbortController();
    const next = createSharingActionMotion(container, sync, media, abort.signal);
    next.update(false);
    next.update(true);
    expect(vi.getTimerCount()).toBe(1);
    abort.abort();
    container.dataset.hoverLocked = 'test-sentinel';
    pointer('pointermove', 20);
    expect(container.dataset.hoverLocked).toBe('test-sentinel');
  });

  it('honors reduced motion without a timeout or transient hover lock', () => {
    reduced = true;
    const { container, sync, motion } = setup();
    motion.update(false);
    motion.update(true);
    expect(sync.disabled).toBe(false);
    expect(container.dataset.sharing).toBe('true');
    expect(container.dataset.morphing).toBeUndefined();
    expect(container.dataset.hoverLocked).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the computed gap including zero instead of a duplicated spacing fallback', () => {
    const { container } = setup();
    container.style.columnGap = '24px';
    resize([resizeEntry(container, 344)], {} as ResizeObserver);
    expect(container.style.getPropertyValue('--play-action-slot-width')).toBe('160px');
    container.style.columnGap = '0px';
    resize([resizeEntry(container, 320)], {} as ResizeObserver);
    expect(container.style.getPropertyValue('--play-action-slot-width')).toBe('160px');
  });
});
