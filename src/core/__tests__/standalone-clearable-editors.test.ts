import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

import { compileClassicRuntimeForBrowserTest } from './classic-runtime-test-asset.ts';

const clearableScript = compileClassicRuntimeForBrowserTest('clearable-editors.js');
const adminStyles = readFileSync(resolve(process.cwd(), 'public/admin.css'), 'utf8');
const eventStyles = readFileSync(resolve(process.cwd(), 'public/events/event.css'), 'utf8');

function visibleRect(): DOMRect {
  return {
    x: 20,
    y: 30,
    top: 30,
    right: 260,
    bottom: 86,
    left: 20,
    width: 240,
    height: 56,
    toJSON: () => ({}),
  };
}

describe('standalone clearable text editors', () => {
  it('shares the main input contract across event and admin controls', async () => {
    const dom = new JSDOM(
      `<!doctype html><html lang="ko"><body>
        <input id="text" type="text" value="abc">
        <input id="search" type="search" value="abc">
        <input id="email" type="email" value="abc@example.com">
        <input id="tel" type="tel" value="123">
        <input id="url" type="url" value="https://example.com">
        <textarea id="textarea">abc</textarea>
        <div id="editable" contenteditable="plaintext-only">abc</div>
        <input id="password" type="password" value="secret">
        <input id="number" type="number" value="12">
        <input id="readonly" type="text" value="abc" readonly>
        <input id="disabled" type="text" value="abc" disabled>
        <input id="opt-out" type="text" value="abc" data-clearable="false">
        <div aria-hidden="true"><input id="hidden-owner" type="text" value="abc"></div>
      </body></html>`,
      {
        pretendToBeVisual: true,
        runScripts: 'outside-only',
        url: 'https://musixquare.com/events/example',
      },
    );
    const { document } = dom.window;
    const rect = visibleRect();
    const rectSpy = vi
      .spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(rect);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => null,
    });
    Object.defineProperty(dom.window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        dom.window.queueMicrotask(() => callback(dom.window.performance.now()));
        return 1;
      },
    });

    dom.window.eval(clearableScript);

    const eligibleIds = ['text', 'search', 'email', 'tel', 'url', 'textarea', 'editable'];
    expect(document.querySelectorAll('.clearable-editor-button')).toHaveLength(eligibleIds.length);
    for (const id of eligibleIds) {
      const editor = document.getElementById(id);
      const button = editor?.nextElementSibling;
      expect(button).toBeInstanceOf(dom.window.HTMLButtonElement);
      expect(button?.getAttribute('aria-controls')).toBe(id);
      expect(button?.getAttribute('aria-label')).toBe('입력 내용 지우기');
      expect((button as HTMLElement | null)?.style.width).toBe('44px');
      expect((button as HTMLElement | null)?.style.height).toBe('44px');
    }
    for (const id of ['password', 'number', 'readonly', 'disabled', 'opt-out', 'hidden-owner']) {
      expect(document.getElementById(id)?.nextElementSibling?.className ?? '').not.toContain(
        'clearable-editor-button',
      );
    }

    const input = document.getElementById('text') as HTMLInputElement;
    const inputEvents: string[] = [];
    input.addEventListener('input', () => inputEvents.push('input'));
    input.addEventListener('change', () => inputEvents.push('change'));
    (input.nextElementSibling as HTMLButtonElement).click();
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(inputEvents).toEqual(['input', 'change']);
    expect(input.nextElementSibling?.className ?? '').not.toContain('clearable-editor-button');

    await Promise.resolve();
    await Promise.resolve();
    const settledRectReads = rectSpy.mock.calls.length;
    const unrelatedRow = document.createElement('div');
    unrelatedRow.textContent = 'updated admin metric';
    document.body.append(unrelatedRow);
    unrelatedRow.dispatchEvent(new dom.window.Event('transitionend', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(rectSpy).toHaveBeenCalledTimes(settledRectReads);

    const dynamic = document.createElement('input');
    dynamic.type = 'text';
    dynamic.value = 'dynamic';
    document.body.append(dynamic);
    await vi.waitFor(() => {
      expect(dynamic.nextElementSibling?.className).toContain('clearable-editor-button');
    });

    document.documentElement.lang = 'en';
    await vi.waitFor(() => {
      expect(dynamic.nextElementSibling?.getAttribute('aria-label')).toBe('Clear input');
    });
  });

  it.each([
    ['admin', adminStyles],
    ['event', eventStyles],
  ])('keeps a small glyph inside a 44px touch target in %s styles', (_surface, styles) => {
    expect(styles).toMatch(/\.clearable-editor-button\s*\{[^}]*position: absolute;/su);
    expect(styles).toMatch(/\.clearable-editor-button::before\s*\{[^}]*inset: 10px;/su);
    expect(styles).toMatch(
      /\.clearable-editor-button svg\s*\{[^}]*width: 14px;[^}]*height: 14px;/su,
    );
    expect(styles).toContain('var(--clearable-editor-reserved-space, 48px)');
    expect(styles).toContain('.clearable-editor-button:focus-visible');
  });
});
