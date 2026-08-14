/**
 * @vitest-environment jsdom
 */
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  initPlaylistTitleMarquee,
  schedulePlaylistTitleMarqueeMeasure,
} from '../playlist-title-marquee.ts';

function title(clientWidth: number, contentWidth: number): HTMLElement {
  const container = document.createElement('span');
  container.className = 'track-name-text';
  const content = document.createElement('span');
  content.className = 'playlist-title-marquee-content';
  content.textContent = 'A title that may be wider than its row';
  container.appendChild(content);
  document.body.appendChild(container);
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(content, 'offsetWidth', { configurable: true, value: contentWidth });
  return container;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('playlist title marquee', () => {
  it('stores an exact travel distance only when the title overflows', async () => {
    const container = title(160, 252);

    schedulePlaylistTitleMarqueeMeasure(container);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(container.classList).toContain('is-playlist-title-overflowing');
    expect(container.style.getPropertyValue('--playlist-marquee-offset')).toBe('-92px');
    expect(container.style.getPropertyValue('--playlist-marquee-duration')).toBe('8.6s');
  });

  it('keeps short titles static and clears stale animation geometry', async () => {
    const container = title(160, 120);
    container.classList.add('is-playlist-title-overflowing');
    container.style.setProperty('--playlist-marquee-offset', '-40px');
    container.style.setProperty('--playlist-marquee-duration', '6s');

    schedulePlaylistTitleMarqueeMeasure(container);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(container.classList).not.toContain('is-playlist-title-overflowing');
    expect(container.style.getPropertyValue('--playlist-marquee-offset')).toBe('');
    expect(container.style.getPropertyValue('--playlist-marquee-duration')).toBe('');
  });

  it('remeasures intrinsic title width after a lazy font finishes loading', async () => {
    const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    const fonts = new EventTarget() as FontFaceSet;
    Object.defineProperty(fonts, 'ready', { value: new Promise<FontFaceSet>(() => {}) });
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    try {
      let contentWidth = 120;
      const container = title(160, contentWidth);
      const content = container.firstElementChild as HTMLElement;
      Object.defineProperty(content, 'offsetWidth', {
        configurable: true,
        get: () => contentWidth,
      });
      initPlaylistTitleMarquee(document.body);
      schedulePlaylistTitleMarqueeMeasure(container);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(container.classList).not.toContain('is-playlist-title-overflowing');

      contentWidth = 230;
      fonts.dispatchEvent(new Event('loadingdone'));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      expect(container.classList).toContain('is-playlist-title-overflowing');
      expect(container.style.getPropertyValue('--playlist-marquee-offset')).toBe('-70px');
    } finally {
      if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('limits touch autoplay to narrow layouts and respects reduced motion', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');

    expect(stylesheet).toContain('@media (any-hover: hover)');
    expect(stylesheet).toContain(
      '@media (max-width: 1279px) and (hover: none) and (pointer: coarse)',
    );
    expect(stylesheet).toContain('.playlist-entry:not(:has(.sub-track-item.active))');
    expect(stylesheet).toContain('.playlist-current-leading.is-current-playing');
    expect(stylesheet).toContain('.sub-track-item.active');
    expect(stylesheet).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.playlist-title-marquee-content\s*\{[\s\S]*?animation:\s*none !important/,
    );

    expect(stylesheet).not.toContain('@media (hover: none) and (pointer: coarse) {');
  });
});
