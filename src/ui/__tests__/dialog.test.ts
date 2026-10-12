/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STYLE_SOURCE = readFileSync(resolve('css/style.css'), 'utf8');
const INDEX_SOURCE = readFileSync(resolve('index.html'), 'utf8');

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../toast.ts', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

function createDialogDOM(): void {
  const overlay = document.createElement('div');
  overlay.id = 'dialog-overlay';
  overlay.setAttribute('aria-hidden', 'true');

  const title = document.createElement('h2');
  title.id = 'dialog-title';
  title.dataset.i18n = 'common.info';

  const msg = document.createElement('p');
  msg.id = 'dialog-message';

  const okBtn = document.createElement('button');
  okBtn.id = 'btn-dialog-ok';
  okBtn.dataset.i18n = 'common.ok';
  // jsdom has no layout; expose the button as focusable to the focus trap.
  Object.defineProperty(okBtn, 'offsetParent', { value: overlay, configurable: true });

  const secondaryBtn = document.createElement('button');
  secondaryBtn.id = 'btn-dialog-secondary';
  secondaryBtn.dataset.i18n = 'common.cancel';
  Object.defineProperty(secondaryBtn, 'offsetParent', { value: overlay, configurable: true });

  overlay.appendChild(title);
  overlay.appendChild(msg);
  const actions = document.createElement('div');
  actions.className = 'dialog-actions adaptive-action-group';
  actions.appendChild(secondaryBtn);
  actions.appendChild(okBtn);
  overlay.appendChild(actions);
  document.body.appendChild(overlay);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  createDialogDOM();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Dialog System', () => {
  it('exposes the active dialog to assistive technology when opened above setup', async () => {
    const { initOverlayObservers, syncOverlayState, __resetModalStackForTests } =
      await import('../dom.ts');
    const { showDialog, closeDialog } = await import('../dialog.ts');
    const setup = document.createElement('div');
    setup.id = 'setup-overlay';
    setup.classList.add('active');
    document.body.appendChild(setup);
    __resetModalStackForTests();
    initOverlayObservers();
    const overlay = document.getElementById('dialog-overlay')!;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    const result = showDialog({ title: 'PIN', message: 'Enter PIN' });
    try {
      expect(overlay.classList.contains('show')).toBe(true);
      expect(overlay.hasAttribute('inert')).toBe(false);
      expect(overlay.getAttribute('aria-hidden')).toBe('false');
    } finally {
      closeDialog('close');
      await result;
      setup.classList.remove('active');
      syncOverlayState();
      __resetModalStackForTests();
    }
  });

  it('keeps a dismissed dialog hidden when its covering modal closes later', async () => {
    const { initOverlayObservers, syncOverlayState, __resetModalStackForTests } =
      await import('../dom.ts');
    const { showDialog, closeDialog } = await import('../dialog.ts');
    const language = document.createElement('div');
    language.id = 'language-dialog-overlay';
    language.setAttribute('aria-hidden', 'true');
    document.body.appendChild(language);
    __resetModalStackForTests();
    initOverlayObservers();
    const overlay = document.getElementById('dialog-overlay')!;
    const result = showDialog({ title: 'Audio recovery', message: 'Restore playback' });
    language.classList.add('show');
    language.setAttribute('aria-hidden', 'false');
    syncOverlayState('language-dialog-overlay');
    closeDialog('superseded');
    await result;
    language.classList.remove('show');
    language.setAttribute('aria-hidden', 'true');
    syncOverlayState();
    try {
      expect(overlay.classList.contains('show')).toBe(false);
      expect(overlay.hasAttribute('inert')).toBe(false);
      expect(overlay.getAttribute('aria-hidden')).toBe('true');
    } finally {
      __resetModalStackForTests();
    }
  });

  it('keeps common actions accessible and lets intrinsic text width choose row wrapping', () => {
    const dialogMarkup = INDEX_SOURCE.slice(
      INDEX_SOURCE.indexOf('id="dialog-overlay"'),
      INDEX_SOURCE.indexOf('id="signaling-recovery-overlay"'),
    );
    expect(dialogMarkup).toContain('role="dialog"');
    expect(dialogMarkup).toContain('aria-modal="true"');
    expect(dialogMarkup).toContain('aria-labelledby="dialog-title"');
    expect(dialogMarkup).toContain('aria-describedby="dialog-message"');
    expect(dialogMarkup.indexOf('id="btn-dialog-secondary"')).toBeLessThan(
      dialogMarkup.indexOf('id="btn-dialog-ok"'),
    );
    expect(dialogMarkup).toContain('class="dialog-actions adaptive-action-group"');
    const parsedMarkup = new DOMParser().parseFromString(INDEX_SOURCE, 'text/html');
    expect(
      parsedMarkup
        .getElementById('signaling-recovery-actions')
        ?.classList.contains('adaptive-action-group'),
    ).toBe(true);
    expect(
      parsedMarkup
        .getElementById('btn-administrator-permissions-save')
        ?.parentElement?.classList.contains('adaptive-action-group'),
    ).toBe(true);
    expect(STYLE_SOURCE).toMatch(/\.dialog-message\s*\{[^}]*word-break:\s*keep-all;/s);
    expect(STYLE_SOURCE).toMatch(
      /\.adaptive-action-group\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*align-items:\s*stretch;/s,
    );
    expect(STYLE_SOURCE).toMatch(
      /\.adaptive-action-group\s*>\s*:is\(button, a\):not\(\[hidden\]\)\s*\{[^}]*max-width:\s*100%;[^}]*flex:\s*1 1 max-content;[^}]*white-space:\s*normal;[^}]*hyphens:\s*auto;[^}]*overflow-wrap:\s*normal;[^}]*word-break:\s*keep-all;/s,
    );
    expect(STYLE_SOURCE).toMatch(
      /\.adaptive-action-group\s*>\s*:is\(button, a\):not\(\[hidden\]\):lang\(ja\)[^{]*\{[^}]*overflow-wrap:\s*normal;[^}]*word-break:\s*normal;[^}]*line-break:\s*strict;/s,
    );
    expect(STYLE_SOURCE).not.toMatch(
      /@media \(max-width:\s*420px\)[\s\S]*?\.dialog-actions\s*\{[^}]*flex-direction:/,
    );
    expect(STYLE_SOURCE).not.toMatch(/\.adaptive-action-group\s*\{[^}]*column-reverse;/s);
  });

  it('lets Japanese and Chinese dialog copy break between characters', () => {
    // keep-all forbids breaks between Han characters, so an unpunctuated
    // Chinese clause would stay on one line wider than the dialog.
    const anchor = STYLE_SOURCE.indexOf('html:lang(ja) .dialog-message');
    expect(anchor).toBeGreaterThan(-1);
    const rule = STYLE_SOURCE.slice(
      STYLE_SOURCE.lastIndexOf('}', anchor) + 1,
      STYLE_SOURCE.indexOf('}', anchor),
    );
    for (const lang of ['ja', 'zh-Hans', 'zh-Hant']) {
      expect(rule).toContain(`html:lang(${lang}) .dialog-message`);
    }
    expect(rule).toMatch(/word-break:\s*normal;/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere;/);
    expect(rule).toMatch(/line-break:\s*strict;/);
  });

  it('gives the dialog copy a clear beat on both sides', () => {
    expect(STYLE_SOURCE).toMatch(/\.dialog-header\s*\{[^}]*padding:\s*30px\s+32px\s+8px;/s);
    expect(STYLE_SOURCE).toMatch(/\.dialog-message\s*\{[^}]*padding:\s*8px\s+32px\s+24px;/s);
  });

  describe('showDialog()', () => {
    it('runs the primary activation hook synchronously before resolving', async () => {
      const { showDialog } = await import('../dialog.ts');
      const order: string[] = [];
      const promise = showDialog({
        title: 'Activation',
        onPrimaryActivation: () => order.push('activation'),
      }).then((result) => {
        order.push(`resolved:${result.action}`);
      });

      document.getElementById('btn-dialog-ok')!.click();
      expect(order).toEqual(['activation']);
      await promise;
      expect(order).toEqual(['activation', 'resolved:ok']);
    });

    it.each(['click', 'Enter'])(
      'runs only the selected secondary activation hook synchronously on %s',
      async (gesture) => {
        const { showDialog } = await import('../dialog.ts');
        const order: string[] = [];
        const primary = vi.fn();
        const promise = showDialog({
          title: 'Choose account',
          secondaryText: 'Sign in with another account',
          actionLayout: 'stacked',
          onPrimaryActivation: primary,
          onSecondaryActivation: () => order.push('activation'),
        }).then((result) => {
          order.push(`resolved:${result.action}`);
        });
        const secondary = document.getElementById('btn-dialog-secondary')!;
        if (gesture === 'click') secondary.click();
        else {
          secondary.focus();
          secondary.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
          );
        }
        expect(primary).not.toHaveBeenCalled();
        expect(order).toEqual(['activation']);
        await promise;
        expect(order).toEqual(['activation', 'resolved:secondary']);
      },
    );

    it('keeps primary first in stacked keyboard order and restores the next ordinary dialog', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const controller = new AbortController();
      const onSecondaryActivation = vi.fn();
      const stacked = showDialog({
        title: 'Choose account',
        secondaryText: 'Switch account',
        actionLayout: 'stacked',
        onSecondaryActivation,
        signal: controller.signal,
      });
      const ordinary = showDialog({ title: 'Next', secondaryText: 'Cancel' });
      const actions = document.querySelector('.dialog-actions')!;
      const primary = document.getElementById('btn-dialog-ok')!;
      const secondary = document.getElementById('btn-dialog-secondary')!;
      expect([...actions.children]).toEqual([primary, secondary]);
      expect(actions.classList.contains('dialog-actions-stacked')).toBe(true);

      secondary.focus();
      secondary.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).toBe(primary);
      primary.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(document.activeElement).toBe(secondary);

      controller.abort();
      vi.advanceTimersByTime(10);
      await expect(stacked).resolves.toEqual({ action: 'superseded' });
      expect([...actions.children]).toEqual([secondary, primary]);
      expect(actions.classList.contains('dialog-actions-stacked')).toBe(false);
      secondary.click();
      await expect(ordinary).resolves.toEqual({ action: 'secondary' });
      expect(onSecondaryActivation).not.toHaveBeenCalled();
      closeDialog();
    });

    it('still resolves a secondary action when its browser activation hook fails', async () => {
      const { showDialog } = await import('../dialog.ts');
      const promise = showDialog({
        secondaryText: 'Sign in',
        onSecondaryActivation: () => {
          throw new Error('Popup blocked');
        },
      });
      document.getElementById('btn-dialog-secondary')!.click();
      await expect(promise).resolves.toEqual({ action: 'secondary' });
    });

    it('keeps runtime labels through added-node translation and the next ordinary dialog', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      // The real i18n observer translates added elements by their static keys.
      // Match that boundary while this suite keeps its lightweight t() mock.
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            for (const element of [node, ...node.querySelectorAll<HTMLElement>('[data-i18n]')]) {
              const key = element.dataset.i18n;
              if (key) element.textContent = key;
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      try {
        const stacked = showDialog({
          title: 'Register room',
          buttonText: 'Register with this account',
          secondaryText: 'Sign in with another account',
          actionLayout: 'stacked',
        });
        const ordinary = showDialog({
          title: 'Next ordinary dialog',
          secondaryText: 'Keep editing',
        });
        await Promise.resolve();
        expect(document.getElementById('btn-dialog-ok')?.textContent).toBe(
          'Register with this account',
        );
        expect(document.getElementById('btn-dialog-secondary')?.textContent).toBe(
          'Sign in with another account',
        );

        closeDialog('ok');
        await stacked;
        vi.advanceTimersByTime(10);
        await Promise.resolve();
        expect(document.getElementById('dialog-title')?.textContent).toBe('Next ordinary dialog');
        expect(document.getElementById('btn-dialog-ok')?.textContent).toBe('common.ok');
        expect(document.getElementById('btn-dialog-secondary')?.textContent).toBe('Keep editing');
        closeDialog('secondary');
        await expect(ordinary).resolves.toEqual({ action: 'secondary' });
      } finally {
        observer.disconnect();
        closeDialog();
      }
    });

    it('returns a Promise<DialogResult>', async () => {
      const { showDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Test', message: 'Hello' });
      expect(promise).toBeInstanceOf(Promise);

      const { closeDialog } = await import('../dialog.ts');
      closeDialog('ok');
      vi.advanceTimersByTime(10);

      const result = await promise;
      expect(result).toEqual({ action: 'ok' });
    });

    it('shows the overlay', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Test' });
      vi.advanceTimersByTime(10);

      const overlay = document.getElementById('dialog-overlay');
      expect(overlay?.classList.contains('show')).toBe(true);

      closeDialog();
      vi.advanceTimersByTime(10);
      await promise;
    });

    it('sets title and message text', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'My Title', message: 'My Message' });
      vi.advanceTimersByTime(10);

      expect(document.getElementById('dialog-title')?.textContent).toBe('My Title');
      expect(document.getElementById('dialog-message')?.textContent).toBe('My Message');

      closeDialog();
      vi.advanceTimersByTime(10);
      await promise;
    });

    it('handles string input (wraps to message)', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog('Hello World');
      vi.advanceTimersByTime(10);

      expect(document.getElementById('dialog-message')?.textContent).toBe('Hello World');
      expect(document.getElementById('dialog-title')?.textContent).toBe('common.info');

      closeDialog();
      vi.advanceTimersByTime(10);
      await promise;
    });

    it('shows secondary button when secondaryText provided', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Test', secondaryText: 'Cancel' });
      vi.advanceTimersByTime(10);

      const btn = document.getElementById('btn-dialog-secondary') as HTMLButtonElement | null;
      expect(btn?.textContent).toBe('Cancel');
      // Use the `hidden` IDL property — index.html uses the HTML5 `hidden`
      // attribute on the static markup (CSP-friendly), so toggling visibility
      // via `style.display` would no-op (user-agent CSS keeps `display: none`).
      expect(btn?.hidden).toBe(false);

      closeDialog();
      vi.advanceTimersByTime(10);
      await promise;
    });

    it('hides secondary button when no secondaryText', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Test' });
      vi.advanceTimersByTime(10);

      const btn = document.getElementById('btn-dialog-secondary') as HTMLButtonElement | null;
      expect(btn?.hidden).toBe(true);

      closeDialog();
      vi.advanceTimersByTime(10);
      await promise;
    });

    it('returns the edited split PIN and keeps its hint adjacent to the input group', async () => {
      const { showDialog } = await import('../dialog.ts');
      const promise = showDialog({
        title: 'Activate room',
        inputField: {
          placeholder: '8-digit PIN',
          maxLength: 8,
          inputMode: 'numeric',
          splitEvery: 4,
          separator: '-',
          validator: (value) => (value === '00000001' ? 'Choose another PIN' : null),
        },
      });
      vi.advanceTimersByTime(10);

      const group = document.querySelector<HTMLElement>('.dialog-input-split');
      const segments = document.querySelectorAll<HTMLInputElement>('.dialog-input-segment');
      const hint = document.querySelector<HTMLElement>('.dialog-hint');
      expect(group).not.toBeNull();
      expect(segments).toHaveLength(2);
      expect([...segments].every((segment) => segment.dataset.clearable === 'false')).toBe(true);
      expect(group?.nextElementSibling).toBe(hint);

      segments[0]!.value = '8765';
      segments[0]!.dispatchEvent(new Event('input', { bubbles: true }));
      segments[1]!.value = '4321';
      segments[1]!.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btn-dialog-ok')?.click();
      vi.advanceTimersByTime(10);

      await expect(promise).resolves.toEqual({ action: 'ok', inputValue: '87654321' });
    });

    it('preserves significant whitespace when an input policy asks for it', async () => {
      const { showDialog } = await import('../dialog.ts');
      const validator = vi.fn(() => null);
      const promise = showDialog({
        title: 'Nickname',
        inputField: { validator, preserveWhitespace: true },
      });
      vi.advanceTimersByTime(10);

      const input = document.querySelector<HTMLElement>('.dialog-input');
      expect(input).not.toBeNull();
      input!.textContent = ' Minsu ';
      document.getElementById('btn-dialog-ok')?.click();
      vi.advanceTimersByTime(10);

      expect(validator).toHaveBeenCalledWith(' Minsu ');
      await expect(promise).resolves.toEqual({ action: 'ok', inputValue: ' Minsu ' });
    });

    it('labels editable input and announces validation state through its hint', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({
        title: 'Nickname',
        inputField: {
          placeholder: 'Display name',
          hint: 'Use a recognizable name',
          validator: () => 'Name is unavailable',
        },
      });
      vi.advanceTimersByTime(10);

      const input = document.querySelector<HTMLElement>('.dialog-input')!;
      const hint = document.getElementById('dialog-input-hint')!;
      expect(input.getAttribute('aria-label')).toBe('Display name');
      expect(input.getAttribute('aria-describedby')).toBe(hint.id);
      expect(input.getAttribute('aria-invalid')).toBe('false');
      expect(hint.getAttribute('aria-live')).toBe('polite');
      expect(hint.getAttribute('aria-atomic')).toBe('true');

      input.textContent = 'Taken';
      document.getElementById('btn-dialog-ok')?.click();
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(hint.textContent).toBe('Name is unavailable');

      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(input.getAttribute('aria-invalid')).toBe('false');
      expect(hint.textContent).toBe('Use a recognizable name');

      closeDialog();
      vi.advanceTimersByTime(10);
      await promise;
    });
  });

  describe('closeDialog()', () => {
    it('resolves with specified action', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Test' });
      vi.advanceTimersByTime(10);

      closeDialog('ok');
      vi.advanceTimersByTime(10);

      const result = await promise;
      expect(result.action).toBe('ok');
    });

    it('removes show class from overlay', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Test' });
      vi.advanceTimersByTime(10);

      closeDialog();
      const overlay = document.getElementById('dialog-overlay');
      expect(overlay?.classList.contains('show')).toBe(false);
      vi.advanceTimersByTime(10);
      await promise;
    });
  });

  describe('Dialog Queue', () => {
    it('queues multiple dialogs and drains sequentially', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const results: string[] = [];

      const p1 = showDialog({ title: 'First' }).then((r) => results.push(r.action));
      const p2 = showDialog({ title: 'Second' }).then((r) => results.push(r.action));
      vi.advanceTimersByTime(10);

      expect(document.getElementById('dialog-title')?.textContent).toBe('First');

      closeDialog('ok');
      vi.advanceTimersByTime(10);

      expect(document.getElementById('dialog-title')?.textContent).toBe('Second');

      closeDialog('secondary');
      vi.advanceTimersByTime(10);

      await Promise.all([p1, p2]);
      expect(results).toEqual(['ok', 'secondary']);
    });

    it('cancels only the active dialog bound to an aborted signal', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const controller = new AbortController();
      const first = showDialog({ title: 'Recovery A', signal: controller.signal });
      const second = showDialog({ title: 'Recovery B' });

      controller.abort();
      vi.advanceTimersByTime(10);

      await expect(first).resolves.toEqual({ action: 'superseded' });
      expect(document.getElementById('dialog-title')?.textContent).toBe('Recovery B');
      closeDialog('ok');
      vi.advanceTimersByTime(10);
      await expect(second).resolves.toEqual({ action: 'ok' });
    });

    it('skips an aborted queued dialog without opening it', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const controller = new AbortController();
      const first = showDialog({ title: 'Blocking dialog' });
      const stale = showDialog({ title: 'Stale recovery', signal: controller.signal });
      controller.abort();

      closeDialog('ok');
      vi.advanceTimersByTime(10);

      await expect(first).resolves.toEqual({ action: 'ok' });
      await expect(stale).resolves.toEqual({ action: 'superseded' });
      expect(document.getElementById('dialog-title')?.textContent).not.toBe('Stale recovery');
    });
  });

  describe('DOM Fallback', () => {
    it('falls back to toast when DOM elements missing', async () => {
      document.body.innerHTML = '';

      const { showDialog } = await import('../dialog.ts');
      const { showToast } = await import('../toast.ts');

      const result = await showDialog({ message: 'Fallback test' });
      vi.advanceTimersByTime(10);

      expect(showToast).toHaveBeenCalledWith('Fallback test');
      expect(result.action).toBe('fallback');
    });
  });

  describe('Keyboard Handling', () => {
    it.each([
      { key: 'Enter', isComposing: true, keyCode: 0 },
      { key: 'Enter', isComposing: false, keyCode: 229 },
      { key: 'Escape', isComposing: true, keyCode: 0 },
      { key: 'Escape', isComposing: false, keyCode: 229 },
    ])('keeps IME $key local to composition ($isComposing/$keyCode)', async (options) => {
      const { showDialog } = await import('../dialog.ts');
      const onPrimaryActivation = vi.fn();
      const resolved = vi.fn();
      const promise = showDialog({
        title: 'Rename',
        dismissible: true,
        inputField: { defaultValue: '한' },
        onPrimaryActivation,
      });
      const observed = promise.then(resolved);
      vi.advanceTimersByTime(10);
      const input = document.querySelector('.dialog-input')!;
      const compositionKey = new KeyboardEvent('keydown', {
        ...options,
        bubbles: true,
        cancelable: true,
      });
      input.dispatchEvent(compositionKey);
      await Promise.resolve();
      expect(compositionKey.defaultPrevented).toBe(false);
      expect(resolved).not.toHaveBeenCalled();
      expect(onPrimaryActivation).not.toHaveBeenCalled();
      expect(document.getElementById('dialog-overlay')?.classList.contains('show')).toBe(true);

      input.textContent = '한글';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: options.key, bubbles: true }));
      expect(await promise).toEqual({
        action: options.key === 'Enter' ? 'ok' : 'escape',
        inputValue: '한글',
      });
      await observed;
      expect(onPrimaryActivation).toHaveBeenCalledTimes(options.key === 'Enter' ? 1 : 0);
      vi.advanceTimersByTime(10);
    });

    it('Escape closes dismissible dialog', async () => {
      const { showDialog } = await import('../dialog.ts');
      const promise = showDialog({ title: 'Esc Test', dismissible: true });
      vi.advanceTimersByTime(10);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(10);

      const result = await promise;
      expect(result.action).toBe('escape');
    });

    it('Escape does NOT close regular dialogs by default', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      let resolved = false;
      const promise = showDialog({ title: 'Default Esc Test' });
      const observedResolution = promise.then(() => {
        resolved = true;
      });
      vi.advanceTimersByTime(10);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(10);

      expect(resolved).toBe(false);

      closeDialog('ok');
      vi.advanceTimersByTime(10);
      await observedResolution;
    });

    it('Escape does NOT close non-dismissible dialog', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      let resolved = false;
      const promise = showDialog({ title: 'No Esc', dismissible: false });
      const observedResolution = promise.then(() => {
        resolved = true;
      });
      vi.advanceTimersByTime(10);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      vi.advanceTimersByTime(10);

      expect(resolved).toBe(false);

      closeDialog('ok');
      vi.advanceTimersByTime(10);
      await observedResolution;
    });
  });

  describe('reading layout', () => {
    const resizeObservers: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];

    beforeEach(() => {
      resizeObservers.length = 0;
      // Exercise the real scrollbar lifecycle; jsdom only needs its absent
      // layout-observer/media APIs supplied, not a fake scrollbar implementation.
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe = vi.fn();
          unobserve = vi.fn();
          disconnect = vi.fn();
          constructor() {
            resizeObservers.push(this);
          }
        },
      );
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      }));
      const overlay = document.getElementById('dialog-overlay')!;
      const panel = document.createElement('div');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-describedby', 'dialog-message');
      panel.append(...overlay.childNodes);
      overlay.appendChild(panel);
      Object.defineProperty(document.getElementById('dialog-message')!, 'offsetParent', {
        value: panel,
        configurable: true,
      });
    });

    afterEach(async () => {
      const { closeDialog } = await import('../dialog.ts');
      closeDialog();
      vi.advanceTimersByTime(20);
      vi.unstubAllGlobals();
    });

    it('keeps RTL and HTML-looking notice text literal and focuses its reading surface', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const overlay = document.getElementById('dialog-overlay')!;
      const message = document.getElementById('dialog-message')!;
      const panel = overlay.querySelector<HTMLElement>('[role="dialog"]')!;
      const text =
        '공지 — مرحبا\n<img src=x onerror="alert(1)"><script>alert(2)</script>\nhttps://example.invalid/ & 끝';
      message.scrollTop = 150;
      panel.scrollTop = 80;
      const promise = showDialog({ title: 'Notice', message: text, contentLayout: 'reading' });
      try {
        vi.advanceTimersByTime(10);
        expect(message.textContent).toBe(text);
        expect(message.querySelector('img, script, a')).toBeNull();
        expect(message.childNodes).toHaveLength(1);
        expect(message.firstChild?.nodeType).toBe(Node.TEXT_NODE);
        expect(message.getAttribute('dir')).toBe('auto');
        expect(message.getAttribute('tabindex')).toBe('0');
        expect(message.hasAttribute('contenteditable')).toBe(false);
        expect(message.scrollTop).toBe(0);
        expect(panel.scrollTop).toBe(0);
        expect(panel.getAttribute('aria-describedby')).toBe(message.id);
        expect(overlay.classList.contains('dialog-reading')).toBe(true);
        expect(document.activeElement).toBe(message);
        expect(panel.querySelectorAll('.cscroll-track')).toHaveLength(1);
      } finally {
        closeDialog('ok');
        await promise;
      }
    });

    it.each(['close', 'abort'] as const)(
      'removes reading state and scrollbar on %s before opening a queued ordinary dialog',
      async (action) => {
        const { showDialog, closeDialog } = await import('../dialog.ts');
        const { bus } = await import('../../core/events.ts');
        const overlay = document.getElementById('dialog-overlay')!;
        const message = document.getElementById('dialog-message')!;
        const controller = new AbortController();
        const reading = showDialog({
          message: 'Long notice',
          contentLayout: 'reading',
          signal: controller.signal,
        });
        const ordinary = showDialog({ title: 'Plain dialog', message: 'Plain text' });
        vi.advanceTimersByTime(10);
        expect(overlay.querySelectorAll('.cscroll-track')).toHaveLength(1);
        expect(resizeObservers).toHaveLength(1);
        if (action === 'abort') controller.abort();
        else closeDialog('close');
        await expect(reading).resolves.toEqual({
          action: action === 'abort' ? 'superseded' : 'close',
        });
        expect(overlay.classList.contains('dialog-reading')).toBe(false);
        expect(message.hasAttribute('tabindex')).toBe(false);
        expect(message.hasAttribute('dir')).toBe(false);
        expect(overlay.querySelector('.cscroll-track')).toBeNull();
        expect(resizeObservers[0]!.disconnect).toHaveBeenCalledTimes(1);
        try {
          vi.advanceTimersByTime(20);
          bus.emit('ui:scrollbar-reveal', message);
          vi.advanceTimersByTime(20);
          expect(document.getElementById('dialog-title')?.textContent).toBe('Plain dialog');
          expect(message.textContent).toBe('Plain text');
          expect(overlay.classList.contains('dialog-reading')).toBe(false);
          expect(message.hasAttribute('tabindex')).toBe(false);
          expect(message.hasAttribute('dir')).toBe(false);
          expect(overlay.querySelector('.cscroll-track')).toBeNull();
          expect(document.activeElement).toBe(document.getElementById('btn-dialog-ok'));
        } finally {
          closeDialog('ok');
          await ordinary;
        }
      },
    );

    it('traps keyboard focus through the reading surface and restores the launcher on Escape', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const launcher = document.createElement('button');
      document.body.appendChild(launcher);
      launcher.focus();
      const activated = vi.fn();
      const promise = showDialog({
        message: 'Read this notice',
        contentLayout: 'reading',
        dismissible: true,
        secondaryText: 'Cancel',
        onPrimaryActivation: activated,
      });
      const overlay = document.getElementById('dialog-overlay')!;
      const message = document.getElementById('dialog-message')!;
      const ok = document.getElementById('btn-dialog-ok')!;
      const key = (name: string, shiftKey = false) => {
        const event = new KeyboardEvent('keydown', {
          key: name,
          shiftKey,
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(event);
        return event;
      };
      try {
        vi.advanceTimersByTime(10);
        expect(document.activeElement).toBe(message);
        expect(key('Enter').defaultPrevented).toBe(false);
        expect(activated).not.toHaveBeenCalled();
        expect(overlay.classList.contains('show')).toBe(true);
        expect(key('Tab', true).defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(ok);
        expect(key('Tab').defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(message);
        // Native Tab advances within the cycle; only its boundaries are trapped.
        expect(key('Tab').defaultPrevented).toBe(false);
        expect(key('Escape').defaultPrevented).toBe(true);
        await expect(promise).resolves.toEqual({ action: 'escape' });
        expect(document.activeElement).toBe(launcher);
        expect(overlay.classList.contains('show')).toBe(false);
        expect(overlay.querySelector('.cscroll-track')).toBeNull();
        expect(key('Tab').defaultPrevented).toBe(false);
        vi.advanceTimersByTime(20);
        expect(document.activeElement).toBe(launcher);
      } finally {
        closeDialog();
        await promise;
      }
    });
  });

  describe('Deferred focus ownership', () => {
    it.each(['abort', 'close'])('preserves restored focus after immediate %s', async (action) => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const launcher = document.createElement('button');
      document.body.appendChild(launcher);
      launcher.focus();
      const controller = new AbortController();
      const promise = showDialog({ title: 'Pending', signal: controller.signal });
      if (action === 'abort') controller.abort();
      else closeDialog();
      await promise;
      expect(document.activeElement).toBe(launcher);
      vi.advanceTimersByTime(10);
      expect(document.activeElement).toBe(launcher);
    });

    it('ignores an obsolete callback while the successor keeps its default focus', async () => {
      const timers = await import('../../core/timers.ts');
      const timerSpy = vi.spyOn(timers, 'setManagedTimer');
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const first = showDialog({
        title: 'First',
        secondaryText: 'Cancel',
        defaultFocus: 'secondary',
      });
      const oldFocus = timerSpy.mock.calls.find(([name]) => name === 'dialog-focus')![1];
      closeDialog();
      await first;
      const second = showDialog({
        title: 'Second',
        secondaryText: 'Cancel',
        defaultFocus: 'primary',
      });
      vi.advanceTimersByTime(10);
      const ok = document.getElementById('btn-dialog-ok');
      expect(document.activeElement).toBe(ok);
      oldFocus();
      expect(document.activeElement).toBe(ok);
      closeDialog();
      await second;
      vi.advanceTimersByTime(10);
    });
  });
  describe('choiceStep', () => {
    const choiceStep = {
      title: 'What should happen to current participants?',
      name: 'test-membership',
      defaultValue: 'keep',
      options: [
        { value: 'keep', label: 'Keep everyone', detail: 'Only new devices enter it.' },
        { value: 'reenter', label: 'Everyone rejoins', detail: 'Everyone joins again.' },
      ],
      buttonText: 'OK',
      backText: 'Back',
    };
    const pinField = {
      maxLength: 8,
      splitEvery: 4,
      inputMode: 'numeric' as const,
      validator: (value: string) => (value.length === 8 ? null : 'invalid PIN'),
    };
    const exposeToFocusTrap = (element: Element) =>
      Object.defineProperty(element, 'offsetParent', {
        value: document.getElementById('dialog-overlay'),
        configurable: true,
      });
    const wrapInPanel = () => {
      const overlay = document.getElementById('dialog-overlay')!;
      const panel = document.createElement('div');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-describedby', 'dialog-message');
      panel.append(...overlay.childNodes);
      overlay.appendChild(panel);
      return panel;
    };
    const fillPin = (first: string, second: string) => {
      const segments = [...document.querySelectorAll<HTMLInputElement>('.dialog-input-segment')];
      segments[0]!.value = first;
      segments[1]!.value = second;
      return segments;
    };
    const key = (target: EventTarget, name: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      target.dispatchEvent(event);
      return event;
    };
    const frame = () => document.querySelector<HTMLElement>('.dialog-choice-frame')!;
    const radios = () => [...document.querySelectorAll<HTMLInputElement>('.dialog-choice-radio')];
    const ok = () => document.getElementById('btn-dialog-ok') as HTMLButtonElement;
    const secondary = () => document.getElementById('btn-dialog-secondary') as HTMLButtonElement;
    const title = () => document.getElementById('dialog-title')!.textContent;
    const message = () => document.getElementById('dialog-message')!;
    // Both action buttons ignore presses just after a page swap.
    const afterSwap = () => vi.advanceTimersByTime(500);

    it('keeps the first page minimal and opens the choice page in place after a valid input', async () => {
      const { showDialog } = await import('../dialog.ts');
      const panel = wrapInPanel();
      const overlay = document.getElementById('dialog-overlay')!;
      const promise = showDialog({
        title: 'Set room password',
        message: 'Set a new 8-digit password.',
        inputField: pinField,
        buttonText: 'Next',
        secondaryText: 'Cancel',
        choiceStep,
      });
      vi.advanceTimersByTime(10);

      // Page 1: the message, the input and Cancel / Next; the choice is hidden.
      expect(title()).toBe('Set room password');
      expect(message().hidden).toBe(false);
      expect(message().firstChild?.textContent).toBe('Set a new 8-digit password.');
      expect(message().querySelector('input[type="radio"]')).toBeNull();
      expect(frame().hidden).toBe(true);
      expect(frame().previousElementSibling).toBe(message());
      expect([ok().textContent, secondary().textContent]).toEqual(['Next', 'Cancel']);
      expect(panel.getAttribute('aria-describedby')).toBe('dialog-message');

      // An invalid PIN stays on page 1 exactly as OK did before.
      ok().click();
      expect(frame().hidden).toBe(true);
      expect(document.getElementById('dialog-input-hint')?.textContent).toBe('invalid PIN');

      fillPin('1234', '5678');
      ok().click();
      expect(overlay.classList.contains('show')).toBe(true);
      expect(overlay.classList.contains('dialog-stepped')).toBe(true);
      expect(title()).toBe('What should happen to current participants?');
      expect(message().hidden).toBe(true);
      expect(frame().hidden).toBe(false);
      expect([ok().textContent, secondary().textContent]).toEqual(['OK', 'Back']);
      expect(secondary().hidden).toBe(false);
      // No subtitle on the choice page: the dialog loses its description.
      expect(panel.hasAttribute('aria-describedby')).toBe(false);

      const group = frame().querySelector('[role="radiogroup"]')!;
      expect(group.getAttribute('aria-labelledby')).toBe('dialog-title');
      expect(radios().map((radio) => [radio.name, radio.value, radio.checked])).toEqual([
        ['test-membership', 'keep', true],
        ['test-membership', 'reenter', false],
      ]);
      expect(document.activeElement).toBe(radios()[0]);
      for (const radio of radios()) {
        const row = radio.closest('label')!;
        expect(row.classList.contains('dialog-choice-option')).toBe(true);
        const surface = radio.nextElementSibling!;
        expect(surface.classList.contains('dialog-choice-surface')).toBe(true);
        // Browse mode reads the radio (name + description), not the copy again.
        expect(surface.getAttribute('aria-hidden')).toBe('true');
        // The check mark sits after the copy, on the reading end edge.
        expect(surface.lastElementChild?.classList.contains('dialog-choice-check')).toBe(true);
        expect(surface.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
        expect(surface.lastElementChild?.querySelector('svg path')).not.toBeNull();
        // Named by the label alone and described by the detail, read once each.
        const name = document.getElementById(radio.getAttribute('aria-labelledby')!)!;
        const detail = document.getElementById(radio.getAttribute('aria-describedby')!)!;
        expect(name.classList.contains('dialog-choice-label')).toBe(true);
        expect(detail.classList.contains('dialog-choice-detail')).toBe(true);
        expect(name.contains(detail)).toBe(false);
      }
      expect(radios()[1]!.closest('label')!.textContent).toBe(
        'Everyone rejoinsEveryone joins again.',
      );

      afterSwap();
      radios()[1]!.click();
      ok().click();
      expect(await promise).toEqual({
        action: 'ok',
        inputValue: '12345678',
        choiceValue: 'reenter',
      });
      vi.advanceTimersByTime(10);
    });

    it('returns to the first page with the PIN kept, then cancels without a change', async () => {
      const { showDialog } = await import('../dialog.ts');
      const panel = wrapInPanel();
      const onSecondaryActivation = vi.fn();
      const resolved = vi.fn();
      const promise = showDialog({
        title: 'Change room password',
        message: 'Set a new 8-digit password.',
        inputField: pinField,
        buttonText: 'Next',
        secondaryText: 'Cancel',
        onSecondaryActivation,
        choiceStep,
      });
      const observed = promise.then(resolved);
      vi.advanceTimersByTime(10);
      const segments = fillPin('1111', '2222');
      ok().click();
      afterSwap();
      radios()[1]!.click();
      secondary().click();
      await Promise.resolve();

      expect(resolved).not.toHaveBeenCalled();
      expect(onSecondaryActivation).not.toHaveBeenCalled();
      expect(title()).toBe('Change room password');
      expect(message().hidden).toBe(false);
      expect(frame().hidden).toBe(true);
      expect([ok().textContent, secondary().textContent]).toEqual(['Next', 'Cancel']);
      expect(panel.getAttribute('aria-describedby')).toBe('dialog-message');
      expect(segments.map((segment) => segment.value)).toEqual(['1111', '2222']);
      expect(document.activeElement).toBe(segments[0]);

      // The choice made before going back is still the one shown next time.
      afterSwap();
      ok().click();
      expect(radios().map((radio) => radio.checked)).toEqual([false, true]);
      expect(document.activeElement).toBe(radios()[1]);
      afterSwap();
      secondary().click();
      afterSwap();
      secondary().click();
      expect(await promise).toMatchObject({ action: 'secondary', inputValue: '11112222' });
      await observed;
      expect(onSecondaryActivation).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10);
    });

    it('moves through both pages by keyboard and confirms exactly once', async () => {
      const { showDialog } = await import('../dialog.ts');
      const onPrimaryActivation = vi.fn();
      const promise = showDialog({
        title: 'PIN',
        inputField: pinField,
        buttonText: 'Next',
        secondaryText: 'Cancel',
        onPrimaryActivation,
        choiceStep,
      });
      vi.advanceTimersByTime(10);
      const segments = fillPin('1234', '5678');
      // Enter in the PIN input acts as Next and lands on the checked option.
      const enter = key(segments[1]!, 'Enter');
      expect(enter.defaultPrevented).toBe(true);
      expect(frame().hidden).toBe(false);
      expect(document.activeElement).toBe(radios()[0]);
      expect(onPrimaryActivation).not.toHaveBeenCalled();
      // Keyboard activation keeps the normal focus ring.
      expect(frame().querySelector('.dialog-choice-pointer-focus')).toBeNull();

      afterSwap();
      radios()[1]!.click();
      radios()[1]!.focus();
      const confirm = key(radios()[1]!, 'Enter');
      expect(confirm.defaultPrevented).toBe(true);
      // A second Enter after the close cannot send another change.
      key(window, 'Enter');
      ok().click();
      expect(await promise).toEqual({
        action: 'ok',
        inputValue: '12345678',
        choiceValue: 'reenter',
      });
      expect(onPrimaryActivation).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10);
    });

    it('goes back with Enter on Back and closes on Escape from either page', async () => {
      const { showDialog } = await import('../dialog.ts');
      const first = showDialog({
        title: 'PIN',
        inputField: pinField,
        buttonText: 'Next',
        secondaryText: 'Cancel',
        choiceStep,
      });
      vi.advanceTimersByTime(10);
      fillPin('1234', '5678');
      ok().click();
      secondary().focus();
      afterSwap();
      expect(key(secondary(), 'Enter').defaultPrevented).toBe(true);
      expect(frame().hidden).toBe(true);
      key(window, 'Escape');
      expect(await first).toMatchObject({ action: 'escape', inputValue: '12345678' });
      vi.advanceTimersByTime(10);

      const second = showDialog({
        title: 'PIN',
        inputField: pinField,
        buttonText: 'Next',
        secondaryText: 'Cancel',
        choiceStep,
      });
      vi.advanceTimersByTime(10);
      fillPin('1234', '5678');
      ok().click();
      key(window, 'Escape');
      expect(await second).toMatchObject({ action: 'escape' });
      vi.advanceTimersByTime(10);
    });

    it('ignores a double press or a held Enter that would also press the next page action', async () => {
      const { showDialog } = await import('../dialog.ts');
      const onPrimaryActivation = vi.fn();
      const resolved = vi.fn();
      const promise = showDialog({
        title: 'PIN',
        inputField: pinField,
        buttonText: 'Next',
        secondaryText: 'Cancel',
        onPrimaryActivation,
        choiceStep,
      });
      const observed = promise.then(resolved);
      vi.advanceTimersByTime(10);
      const segments = fillPin('1234', '5678');

      // Double click on Next: the second click lands on OK and is ignored.
      ok().click();
      ok().click();
      secondary().click();
      await Promise.resolve();
      expect(frame().hidden).toBe(false);
      expect(resolved).not.toHaveBeenCalled();
      // The actions move down; a second press landing on a row keeps the
      // default, whether it hits the row's radio (which covers the row) or
      // its label.
      radios()[1]!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }),
      );
      expect(radios().map((radio) => radio.checked)).toEqual([true, false]);
      radios()[1]!
        .closest('label')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
      expect(radios().map((radio) => radio.checked)).toEqual([true, false]);

      // Double click on Back: the second click lands on Cancel and is ignored.
      afterSwap();
      secondary().click();
      secondary().click();
      await Promise.resolve();
      expect(frame().hidden).toBe(true);
      expect(resolved).not.toHaveBeenCalled();

      // A held Enter (key repeat) neither moves on nor confirms.
      afterSwap();
      key(segments[1]!, 'Enter', { repeat: true });
      expect(frame().hidden).toBe(true);
      key(segments[1]!, 'Enter');
      expect(frame().hidden).toBe(false);
      key(radios()[0]!, 'Enter', { repeat: true });
      afterSwap();
      key(radios()[0]!, 'Enter', { repeat: true });
      await Promise.resolve();
      expect(resolved).not.toHaveBeenCalled();
      expect(onPrimaryActivation).not.toHaveBeenCalled();

      key(radios()[0]!, 'Enter');
      expect(await promise).toEqual({
        action: 'ok',
        inputValue: '12345678',
        choiceValue: 'keep',
      });
      await observed;
      expect(onPrimaryActivation).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10);
    });

    it('traps focus on the checked option and the two actions while the choice page is shown', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({
        title: 'PIN',
        inputField: pinField,
        buttonText: 'Next',
        secondaryText: 'Cancel',
        choiceStep,
      });
      vi.advanceTimersByTime(10);
      const segments = fillPin('1234', '5678');
      for (const element of [...segments, ...radios()]) exposeToFocusTrap(element);
      ok().click();
      afterSwap();
      radios()[1]!.click();
      const tab = (shiftKey = false) => key(window, 'Tab', { shiftKey });

      ok().focus();
      expect(tab().defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(radios()[1]);
      expect(tab(true).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(ok());
      // Inside the cycle the browser moves focus natively; the trap stays out.
      radios()[1]!.focus();
      expect(tab().defaultPrevented).toBe(false);
      closeDialog();
      await promise;
      vi.advanceTimersByTime(10);
    });

    it('suppresses the keyboard ring after a pointer Next until the next key', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({
        title: 'PIN',
        inputField: pinField,
        buttonText: 'Next',
        secondaryText: 'Cancel',
        choiceStep,
      });
      vi.advanceTimersByTime(10);
      fillPin('1234', '5678');
      ok().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      const list = frame().querySelector('.dialog-choice-list')!;
      expect(document.activeElement).toBe(radios()[0]);
      expect(list.classList.contains('dialog-choice-pointer-focus')).toBe(true);
      key(radios()[0]!, 'ArrowDown');
      expect(list.classList.contains('dialog-choice-pointer-focus')).toBe(false);
      closeDialog();
      await promise;
      vi.advanceTimersByTime(10);
    });

    it('keeps the panel top edge still across page swaps where the viewport has room', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const panel = wrapInPanel();
      const overlay = document.getElementById('dialog-overlay')!;
      // A centred flex panel: page 1 is 300px tall, page 2 is 390px (451px in
      // the short viewport). The relative offset moves it from that centre.
      let viewportHeight = 844;
      let choiceHeight = 390;
      overlay.style.paddingTop = '24px';
      overlay.style.paddingBottom = '24px';
      Object.defineProperty(overlay, 'clientHeight', {
        get: () => viewportHeight,
        configurable: true,
      });
      const height = () => (frame().hidden ? 300 : choiceHeight);
      const offset = () => panel.style.getPropertyValue('--dialog-step-offset');
      Object.defineProperty(panel, 'offsetHeight', { get: height, configurable: true });
      Object.defineProperty(panel, 'offsetTop', {
        get: () => (viewportHeight - height()) / 2 + (parseFloat(offset()) || 0),
        configurable: true,
      });
      const promise = showDialog({
        title: 'PIN',
        inputField: pinField,
        buttonText: 'Next',
        secondaryText: 'Cancel',
        choiceStep,
      });
      vi.advanceTimersByTime(10);
      fillPin('1234', '5678');
      expect(panel.offsetTop).toBe(272);

      // Room below: page 2 keeps page 1's top edge (272), not its centre (227).
      ok().click();
      expect(offset()).toBe('45px');
      expect(panel.offsetTop).toBe(272);
      // Back: page 1 is centred at that edge again, with no offset.
      afterSwap();
      secondary().click();
      expect(offset()).toBe('');
      expect(panel.offsetTop).toBe(272);

      // A short viewport moves the panel up only as far as it must:
      // 568 - 24 - 451 = 93, so page 2 sits 35px below its centre (58.5).
      viewportHeight = 568;
      choiceHeight = 451;
      window.dispatchEvent(new Event('resize'));
      afterSwap();
      ok().click();
      expect(offset()).toBe('35px');
      expect(panel.offsetTop).toBeCloseTo(93.5, 5);
      expect(panel.offsetTop + height()).toBeLessThanOrEqual(568 - 24 + 0.5);

      // A resize re-centres the page, and closing leaves no offset behind.
      window.dispatchEvent(new Event('resize'));
      expect(offset()).toBe('');
      afterSwap();
      secondary().click();
      expect(offset()).toBe('');
      afterSwap();
      ok().click();
      expect(offset()).toBe('35px');
      closeDialog('secondary');
      await promise;
      expect(offset()).toBe('');
      vi.advanceTimersByTime(10);
    });

    it('tears the page down on close and abort so the next dialog has no choice', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const panel = wrapInPanel();
      const controller = new AbortController();
      const aborted = showDialog({
        title: 'PIN',
        inputField: pinField,
        buttonText: 'Next',
        choiceStep,
        signal: controller.signal,
      });
      vi.advanceTimersByTime(10);
      fillPin('1234', '5678');
      ok().click();
      expect(message().hidden).toBe(true);
      controller.abort();
      expect(await aborted).toMatchObject({ action: 'superseded', choiceValue: 'keep' });
      expect(document.querySelector('.dialog-choice-frame')).toBeNull();
      expect(document.getElementById('dialog-overlay')!.classList.contains('dialog-stepped')).toBe(
        false,
      );
      expect(message().hidden).toBe(false);
      expect(panel.getAttribute('aria-describedby')).toBe('dialog-message');
      vi.advanceTimersByTime(10);

      const plain = showDialog({ title: 'Plain', message: 'Plain message' });
      vi.advanceTimersByTime(10);
      expect(document.querySelector('.dialog-choice-frame')).toBeNull();
      expect(secondary().hidden).toBe(true);
      expect(message().textContent).toBe('Plain message');
      closeDialog('ok');
      const result = await plain;
      expect(result).toEqual({ action: 'ok', inputValue: undefined });
      expect('choiceValue' in result).toBe(false);
      vi.advanceTimersByTime(10);
    });

    it('checks the first option when the default is not offered and omits details cleanly', async () => {
      const { showDialog, closeDialog } = await import('../dialog.ts');
      const promise = showDialog({
        title: 'Choice',
        choiceStep: {
          ...choiceStep,
          defaultValue: 'missing',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: () => 'B' },
          ],
        },
      });
      // Without an input, the first page's primary opens the choice page.
      ok().click();
      expect(radios().map((radio) => radio.checked)).toEqual([true, false]);
      expect(radios().every((radio) => !radio.hasAttribute('aria-describedby'))).toBe(true);
      expect(document.querySelectorAll('.dialog-choice-detail')).toHaveLength(0);
      expect(document.querySelectorAll('.dialog-choice-label')[1]?.textContent).toBe('B');
      closeDialog('secondary');
      expect(await promise).toEqual({
        action: 'secondary',
        inputValue: undefined,
        choiceValue: 'a',
      });
      vi.advanceTimersByTime(10);
    });

    it('styles the rows like the language list with the settings choice radius in either direction', () => {
      const block = (selector: string) => {
        const start = STYLE_SOURCE.indexOf(`\n  ${selector} {`);
        expect(start, selector).toBeGreaterThan(-1);
        return STYLE_SOURCE.slice(start, STYLE_SOURCE.indexOf('}', start));
      };
      expect(STYLE_SOURCE).not.toContain('.dialog-choice-legend');
      expect(STYLE_SOURCE).not.toContain('accent-color: var(--primary)');
      const surface = block('.dialog-choice-surface');
      expect(surface).toContain('border-radius: var(--radius-m)');
      expect(surface).toContain('justify-content: space-between');
      expect(surface).toContain('min-block-size: 52px');
      // Forced colors paint the transparent border, as on the language rows;
      // the 1px smaller padding keeps the row height.
      expect(surface).toContain('border: 1px solid transparent');
      expect(surface).toMatch(/padding-block: 13px;\s*padding-inline: 13px;/);
      expect(block('.dialog-choice-radio:checked + .dialog-choice-surface')).toMatch(
        /background: var\(--surface-2\);[^}]*color: var\(--primary\);/s,
      );
      expect(
        block('.dialog-choice-radio:checked + .dialog-choice-surface .dialog-choice-check'),
      ).toContain('opacity: 1');
      expect(block('.dialog-choice-radio:focus-visible + .dialog-choice-surface')).toContain(
        'outline: 2px solid var(--primary)',
      );
      // The native radio stays focusable and announced but is not painted. It
      // covers the whole row, so touch exploration, the screen reader's focus
      // outline and scroll-into-view use the row's bounds, and taps hit it.
      const radio = block('.dialog-choice-radio');
      expect(radio).toContain('opacity: 0');
      expect(radio).not.toMatch(/display:\s*none|visibility:\s*hidden|pointer-events:\s*none/);
      expect(radio).toMatch(/top: 0;\s*left: 0;\s*width: 100%;\s*height: 100%;/);
      expect(radio).not.toMatch(/\b(?:inline|block)-size:\s*1px/);
      // A wrapped step-2 question uses the row labels' line height.
      expect(block('#dialog-overlay.dialog-stepped .dialog-title')).toContain('line-height: 1.3');
      // The panel keeps its top edge across page swaps through a relative offset.
      expect(block('#dialog-overlay.dialog-stepped .dialog')).toMatch(
        /position: relative;\s*top: var\(--dialog-step-offset, 0px\);/,
      );
      // Only the list scrolls in short landscape viewports; actions stay put.
      expect(block('.dialog-choice-list')).toContain('overflow-y: auto');
      expect(block('#dialog-overlay .dialog > .dialog-choice-frame')).toContain('flex-shrink: 1');
      // The language list's fades cover the choice list too.
      expect(STYLE_SOURCE).toMatch(/\.language-list-edge,\s*\.dialog-choice-edge \{/);
      expect(STYLE_SOURCE).toMatch(
        /\.dialog-choice-list\.can-scroll-down ~ \.dialog-choice-edge-bottom \{\s*opacity: 1;/,
      );
      // The radio's full-width stretch is the one direction-neutral physical
      // offset; everything else stays logical so RTL mirrors the rows.
      const choiceRules = STYLE_SOURCE.slice(
        STYLE_SOURCE.indexOf('.dialog-choice-frame {'),
        STYLE_SOURCE.indexOf('.dialog-choice-check svg {'),
      ).replace(radio, '');
      expect(choiceRules).not.toMatch(
        /(?:margin|padding|inset)-(?:left|right)|text-align: (?:left|right)|\b(?:left|right):/,
      );
      // Inline offsets and uneven inline shorthands compile to :is() fallbacks
      // that the Chromium 79 (legacy TV) build rejects.
      expect(choiceRules).not.toMatch(/inset-inline|(?:padding|margin)-inline:\s*\S+\s+\S+;/);
      // Forced colors fill and outline the chosen row with Highlight. Its copy
      // keeps the OS text colors on Chromium's Canvas text backplate, where
      // HighlightText would vanish; only the check mark takes HighlightText.
      const forced = STYLE_SOURCE.slice(
        STYLE_SOURCE.lastIndexOf('@media (forced-colors: active) {'),
      );
      expect(forced).toMatch(
        /\.dialog-choice-radio:checked \+ \.dialog-choice-surface \{\s*border-color: Highlight !important;\s*background: Highlight !important;\s*\}/,
      );
      expect(forced).toMatch(
        /\.dialog-choice-radio:checked \+ \.dialog-choice-surface \.dialog-choice-check \{\s*color: HighlightText !important;\s*\}/,
      );
      expect(forced).not.toContain('.dialog-choice-radio:checked + .dialog-choice-surface *');
    });

    it('lets Japanese and Chinese choice copy wrap between characters', () => {
      const anchor = STYLE_SOURCE.indexOf('html:lang(ja) .dialog-message');
      const rule = STYLE_SOURCE.slice(anchor, STYLE_SOURCE.indexOf('}', anchor));
      for (const lang of ['ja', 'zh-Hans', 'zh-Hant']) {
        expect(rule).toContain(`html:lang(${lang}) .dialog-choice-text`);
        expect(rule).toContain(`html:lang(${lang}) #dialog-overlay.dialog-stepped .dialog-title`);
      }
      // Korean keeps words whole in the choice copy and the stepped title.
      expect(STYLE_SOURCE).toMatch(
        /#dialog-overlay\.dialog-stepped \.dialog-title \{[^}]*word-break: keep-all;/,
      );
    });

    it('gives a stepped dialog the short-height spacing on landscape phones', () => {
      const start = STYLE_SOURCE.indexOf(
        '@media (max-height: 480px) {\n    #dialog-overlay.dialog-stepped {',
      );
      expect(start).toBeGreaterThan(-1);
      const media = STYLE_SOURCE.slice(start, STYLE_SOURCE.indexOf('\n  }\n', start));
      expect(media).toMatch(/#dialog-overlay\.dialog-stepped \{\s*padding-block: 12px;/);
      expect(media).toContain('max-height: calc(100dvh - 24px)');
      expect(media).toMatch(/\.dialog-choice-surface \{\s*padding-block: 11px;/);
      expect(media).toMatch(/\.dialog-actions > button \{\s*min-height: 48px;/);
    });
  });
});
