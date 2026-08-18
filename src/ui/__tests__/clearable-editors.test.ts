/** @vitest-environment jsdom */

import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/index.ts';
import { initClearableEditors } from '../clearable-editors.ts';

type ClearableEditorsController = ReturnType<typeof initClearableEditors>;

const RECT = {
  x: 20,
  y: 30,
  left: 20,
  top: 30,
  width: 240,
  height: 48,
  right: 260,
  bottom: 78,
  toJSON: () => ({}),
} as DOMRect;

let controller: ClearableEditorsController | null = null;

function renderRect(element: Element, rect: DOMRect = RECT): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect,
  });
}

function clearButtonFor(id: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `.clearable-editor-button[aria-controls="${id}"]`,
  );
}

async function waitForRefresh(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 25));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  controller?.destroy();
  controller = null;
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'elementFromPoint');
  document.body.innerHTML = '';
});

describe('clearable editor eligibility', () => {
  it('includes editable text inputs, textarea, and contenteditable controls', () => {
    document.body.innerHTML = `
      <input id="text" value="text">
      <input id="search" type="search" value="search">
      <input id="email" type="email" value="a@example.com">
      <input id="tel" type="tel" value="123">
      <input id="url" type="url" value="https://example.com">
      <textarea id="textarea">notes</textarea>
      <div id="editable" contenteditable="plaintext-only">message</div>
    `;
    document
      .querySelectorAll('input, textarea, [contenteditable]')
      .forEach((element) => renderRect(element));

    controller = initClearableEditors();

    expect(document.querySelectorAll('.clearable-editor-button')).toHaveLength(7);
    for (const id of ['text', 'search', 'email', 'tel', 'url', 'textarea', 'editable']) {
      expect(clearButtonFor(id)).not.toBeNull();
      expect(document.getElementById(id)?.classList).toContain('clearable-editor-active');
    }
  });

  it('excludes sensitive, non-text, unavailable, hidden, and opted-out controls', () => {
    document.body.innerHTML = `
      <input id="password" type="password" value="secret">
      <input id="file" type="file">
      <input id="number" type="number" value="1">
      <input id="date" type="date" value="2026-08-18">
      <input id="checkbox" type="checkbox" checked>
      <input id="disabled" value="x" disabled>
      <input id="readonly" value="x" readonly>
      <fieldset disabled><input id="fieldset-disabled" value="x"></fieldset>
      <input id="aria-hidden" value="x" aria-hidden="true">
      <input id="ime-dummy" value="x" class="visually-offscreen" data-clearable="false">
      <div id="disabled-editor" contenteditable="true" data-disabled="true">x</div>
      <div id="false-editor" contenteditable="false">x</div>
    `;
    document.querySelectorAll('input, [contenteditable]').forEach((element) => renderRect(element));

    controller = initClearableEditors();

    expect(document.querySelectorAll('.clearable-editor-button')).toHaveLength(0);
    document.querySelectorAll('input, [contenteditable]').forEach((element) => {
      expect(clearButtonFor(element.id)).toBeNull();
    });
  });
});

describe('clear button behavior', () => {
  it('clears a native input, emits input then change, and restores editor focus', () => {
    const input = document.createElement('input');
    input.id = 'nickname';
    input.value = 'MUSIXQUARE';
    renderRect(input);
    document.body.appendChild(input);
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    controller = initClearableEditors();

    const button = clearButtonFor(input.id);
    expect(button?.style.width).toBe('44px');
    expect(button?.style.height).toBe('44px');
    expect(button?.tabIndex).toBe(0);
    expect(button?.getAttribute('aria-label')).toBe(t('common.clear_input'));
    expect(button?.dataset.i18nAriaLabel).toBe('common.clear_input');
    expect(input.nextElementSibling).toBe(button);

    button?.click();

    expect(input.value).toBe('');
    expect(events).toEqual(['input', 'change']);
    expect(document.activeElement).toBe(input);
    expect(clearButtonFor(input.id)).toBeNull();
    expect(input.classList).not.toContain('clearable-editor-active');
  });

  it('clears contenteditable markup through the same event contract', () => {
    const editor = document.createElement('div');
    editor.id = 'rich-editor';
    editor.setAttribute('contenteditable', 'true');
    editor.innerHTML = '<span>hello</span><br><b>world</b>';
    renderRect(editor);
    document.body.appendChild(editor);
    const events: string[] = [];
    editor.addEventListener('input', () => events.push('input'));
    editor.addEventListener('change', () => events.push('change'));
    controller = initClearableEditors();

    clearButtonFor(editor.id)?.click();

    expect(editor.innerHTML).toBe('');
    expect(events).toEqual(['input', 'change']);
    expect(document.activeElement).toBe(editor);
  });

  it('does not clear a field that becomes ineligible before activation', () => {
    const password = document.createElement('input');
    password.id = 'sensitive';
    password.type = 'text';
    password.value = 'secret';
    renderRect(password);
    document.body.appendChild(password);
    const inputEvent = vi.fn();
    password.addEventListener('input', inputEvent);
    controller = initClearableEditors();
    const button = clearButtonFor(password.id);

    password.type = 'password';
    button?.click();

    expect(password.value).toBe('secret');
    expect(inputEvent).not.toHaveBeenCalled();
  });
});

describe('dynamic editor lifecycle', () => {
  it('uses rendered geometry when an active setup panel overrides a legacy hidden attribute', () => {
    const panel = document.createElement('div');
    panel.hidden = true;
    panel.style.display = 'flex';
    const input = document.createElement('input');
    input.id = 'visible-hidden-panel-input';
    input.value = '123';
    renderRect(input);
    panel.appendChild(input);
    document.body.appendChild(panel);

    controller = initClearableEditors();

    expect(clearButtonFor(input.id)?.hidden).toBe(false);
    expect(input.classList).toContain('clearable-editor-active');
  });

  it('adds and removes the affordance from delegated input events without a full re-init', async () => {
    controller = initClearableEditors();
    const input = document.createElement('input');
    input.id = 'dynamic';
    renderRect(input);
    document.body.appendChild(input);

    input.value = 'a';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitForRefresh();
    expect(clearButtonFor(input.id)).not.toBeNull();

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitForRefresh();
    expect(clearButtonFor(input.id)).toBeNull();
  });

  it('reads the post-sanitization value after target input handlers finish', async () => {
    const input = document.createElement('input');
    input.id = 'sanitized';
    renderRect(input);
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D+/g, '');
    });
    document.body.appendChild(input);
    controller = initClearableEditors();

    input.value = 'not-a-number';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitForRefresh();

    expect(input.value).toBe('');
    expect(clearButtonFor(input.id)).toBeNull();
  });

  it('observes programmatic contenteditable mutations and removals', async () => {
    const editor = document.createElement('div');
    editor.id = 'mutated';
    editor.setAttribute('contenteditable', 'true');
    renderRect(editor);
    document.body.appendChild(editor);
    controller = initClearableEditors();

    editor.textContent = 'programmatic text';
    await waitForRefresh();
    expect(clearButtonFor(editor.id)).not.toBeNull();

    editor.remove();
    await waitForRefresh();
    expect(clearButtonFor(editor.id)).toBeNull();
  });

  it('repositions fixed portal buttons after a scroll-driven refresh', async () => {
    const input = document.createElement('input');
    input.id = 'moving';
    input.value = 'text';
    let rect = RECT;
    Object.defineProperty(input, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect,
    });
    document.body.appendChild(input);
    controller = initClearableEditors();
    expect(clearButtonFor(input.id)?.style.top).toBe('32px');

    rect = { ...RECT, y: 130, top: 130, bottom: 178 } as DOMRect;
    document.dispatchEvent(new Event('scroll'));
    await waitForRefresh();

    expect(clearButtonFor(input.id)?.style.top).toBe('132px');
  });

  it('keeps a compact editor stable when its own button covers the center hit-test point', () => {
    const input = document.createElement('input');
    input.id = 'compact';
    input.value = 'x';
    renderRect(input, { ...RECT, width: 80, right: 100 } as DOMRect);
    document.body.appendChild(input);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => {
        const button = clearButtonFor(input.id);
        return button && button.style.pointerEvents !== 'none' ? button : input;
      }),
    });

    controller = initClearableEditors();
    controller.refresh();

    const button = clearButtonFor(input.id);
    expect(button?.hidden).toBe(false);
    expect(button?.style.pointerEvents).toBe('');
  });

  it('ignores unrelated DOM mutations and transitions once an entry is positioned', async () => {
    const input = document.createElement('input');
    input.id = 'stable';
    input.value = 'x';
    const rect = vi.fn(() => RECT);
    Object.defineProperty(input, 'getBoundingClientRect', { configurable: true, value: rect });
    document.body.appendChild(input);
    controller = initClearableEditors();
    const callsAfterInit = rect.mock.calls.length;

    const unrelated = document.createElement('div');
    document.body.appendChild(unrelated);
    unrelated.dispatchEvent(new Event('transitionrun', { bubbles: true }));
    await waitForRefresh();

    expect(rect).toHaveBeenCalledTimes(callsAfterInit);
  });
});

describe('clear button accessibility and layout', () => {
  it('generates an editor id and keeps the button inside the same modal tree', () => {
    document.body.innerHTML = `
      <div role="dialog" aria-modal="true">
        <textarea>draft</textarea>
      </div>
    `;
    const editor = document.querySelector('textarea')!;
    renderRect(editor);

    controller = initClearableEditors();

    const button = editor.nextElementSibling as HTMLButtonElement | null;
    expect(editor.id).toMatch(/^clearable-editor-/);
    expect(button?.classList).toContain('clearable-editor-button');
    expect(button?.tabIndex).toBe(0);
    expect(button?.getAttribute('aria-controls')).toBe(editor.id);
    expect(button?.closest('[role="dialog"]')).toBe(editor.closest('[role="dialog"]'));
  });

  it('reserves symmetric space for centered fields and uses a compact reservation when narrow', () => {
    const input = document.createElement('input');
    input.id = 'centered';
    input.value = '123';
    input.style.textAlign = 'center';
    renderRect(input, { ...RECT, width: 120, right: 140 } as DOMRect);
    document.body.appendChild(input);

    controller = initClearableEditors();

    expect(input.classList).toContain('clearable-editor-centered');
    expect(input.style.getPropertyValue('--clearable-editor-reserved-space')).toBe('28px');
    expect(clearButtonFor(input.id)?.style.left).toBe('116px');
  });

  it('keeps the YouTube clear action inside the editor and outside the search hit area', () => {
    document.body.innerHTML = `
      <div class="yt-search-input-wrapper">
        <div id="youtube-url-input" contenteditable="true">city pop</div>
        <button id="youtube-search-btn" type="button"></button>
      </div>
    `;
    const editor = document.getElementById('youtube-url-input') as HTMLDivElement;
    const search = document.getElementById('youtube-search-btn') as HTMLButtonElement;
    const editorRect = { ...RECT, width: 196, right: 216 } as DOMRect;
    const searchRect = {
      ...RECT,
      x: 216,
      left: 216,
      width: 44,
      right: 260,
    } as DOMRect;
    renderRect(editor, editorRect);
    renderRect(search, searchRect);

    controller = initClearableEditors();

    const clear = clearButtonFor(editor.id);
    expect(editor.nextElementSibling).toBe(clear);
    expect(clear?.nextElementSibling).toBe(search);
    expect(
      Number.parseFloat(clear?.style.left || 'NaN') +
        Number.parseFloat(clear?.style.width || 'NaN'),
    ).toBeLessThanOrEqual(searchRect.left);
    expect(editor.style.getPropertyValue('--clearable-editor-reserved-space')).toBe('48px');
  });
});

describe('clear affordance styling', () => {
  it('reserves inline text space and keeps the visible glyph smaller than the touch target', async () => {
    const stylesheet = await readFile('css/style.css', 'utf8');
    expect(stylesheet).toContain('var(--clearable-editor-reserved-space, 48px)');
    expect(stylesheet).toContain('.clearable-editor-active.clearable-editor-centered');
    expect(stylesheet).toContain('var(--clearable-editor-base-padding-inline-start, 0px)');
    expect(stylesheet).toMatch(/\.clearable-editor-button::before\s*{[^}]*inset: 10px;/s);
    expect(stylesheet).toMatch(
      /\.clearable-editor-button svg\s*{[^}]*width: 14px;[^}]*height: 14px;/s,
    );
    expect(stylesheet).toMatch(/\.clearable-editor-button\[hidden\]\s*{[^}]*display: none;/s);
    expect(stylesheet).toContain('.clearable-editor-button:focus-visible');
    expect(stylesheet).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
