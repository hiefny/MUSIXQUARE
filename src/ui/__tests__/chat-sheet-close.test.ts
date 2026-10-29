/**
 * @vitest-environment jsdom
 *
 * Owner decision (2026-10-30): the phone and tablet chat sheet shows no Close.
 * 9.0.20 put a visible Close at its top start (owner decision 2026-10-28,
 * dialog exit item F12); the owner saw it on a device and asked for it to go.
 * The sheet closes as before 9.0.20: a tap or a swipe down on its drag handle,
 * Enter or Space on the focused handle, an outside tap on the backdrop, Escape
 * and Back (chat.test.ts). The desktop chat panel is not a window.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseCss } from 'postcss';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(path), 'utf8');

const markup = new DOMParser().parseFromString(read('index.html'), 'text/html');

describe('chat sheet without a Close', () => {
  it('starts the sheet with its drag handle, which holds no control', () => {
    const drawer = markup.getElementById('chat-drawer')!;
    const header = drawer.querySelector('.chat-drawer-header')!;
    // The sheet makes the handle a focusable separator or button, so it is the
    // sheet's first control and nothing sits before it or inside it.
    expect(drawer.firstElementChild).toBe(header);
    expect(header.querySelector('button')).toBeNull();
    expect(markup.getElementById('btn-chat-close')).toBeNull();
    expect(drawer.querySelector('.chat-drawer-close')).toBeNull();
  });

  it('leaves no markup, rule, wiring or copy of the Close', () => {
    const html = read('index.html');
    for (const fragment of ['btn-chat-close', 'chat-drawer-close', 'chat.close']) {
      expect(html, fragment).not.toContain(fragment);
    }

    // css/app.css imports these four files; together they are the app stylesheet.
    const retired = /(?:\.chat-drawer-close|#btn-chat-close)(?![\w-])/u;
    for (const path of [
      'css/style.css',
      'css/desktop.css',
      'css/rtl.css',
      'css/playback-actions.css',
    ]) {
      parseCss(read(path)).walkRules((rule) => {
        expect(retired.test(rule.selector), `${path}: ${rule.selector}`).toBe(false);
      });
    }

    const chatSource = read('src/ui/chat.ts');
    for (const fragment of ['btn-chat-close', 'chat-drawer-close']) {
      expect(chatSource, fragment).not.toContain(fragment);
    }

    const locales = readdirSync(resolve('src/i18n')).filter((name) =>
      /^[a-z]{2,3}(?:-[a-z]+)?\.ts$/u.test(name),
    );
    expect(locales).toHaveLength(42);
    for (const locale of locales) {
      expect(read(`src/i18n/${locale}`), locale).not.toContain(`'chat.close'`);
    }
  });
});
