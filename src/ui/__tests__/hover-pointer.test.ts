/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { initHoverPointer } from '../hover-pointer.ts';

function pointer(type: string, pointerType: string): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

describe('hover pointer flag', () => {
  afterEach(() => {
    delete document.documentElement.dataset.hoverPointer;
  });

  it('marks a pen or mouse as a hover pointer and clears it on touch', () => {
    initHoverPointer();
    const root = document.documentElement;

    document.dispatchEvent(pointer('pointermove', 'touch'));
    expect(root.hasAttribute('data-hover-pointer')).toBe(false);

    document.dispatchEvent(pointer('pointermove', 'pen'));
    expect(root.hasAttribute('data-hover-pointer')).toBe(true);

    document.dispatchEvent(pointer('pointerdown', 'touch'));
    expect(root.hasAttribute('data-hover-pointer')).toBe(false);

    document.dispatchEvent(pointer('pointermove', 'mouse'));
    expect(root.hasAttribute('data-hover-pointer')).toBe(true);
  });

  it('mirrors the reorder grip and title marquee hover rules for the flag', () => {
    const css = readFileSync(resolve('css/style.css'), 'utf8');
    expect(css).toContain(
      'html[data-hover-pointer] .track-item:hover .playlist-reorder-handle .playlist-reorder-grip',
    );
    expect(css).toMatch(
      /html\[data-hover-pointer\]\s+\.track-item:hover\s+\.track-name-text\.is-playlist-title-overflowing\s+> \.playlist-title-marquee-content/u,
    );
  });
});
